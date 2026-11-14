"""Whether a Python program provably starts no process, so a command word in its text is data.

The deny rules read an interpreter's program as text: `os.system('sudo id')` has no shell
command position, so any `sudo` or `rm -rf ~` in the program is refused. Most such programs
in practice only edit a file by string replacement, and the word is in the text they write.
`inert(program)` lets a rule tell those apart. `read_only(program)` is the narrower proof that
the program also changes no file, for a rule that guards a file the program names.

It is an allowlist, and anything it does not recognise refuses. A program is inert only when
it parses, and when every import, every attribute it reads and every builtin it names is one
listed below. None of them can start a process or reach one that does: `pathlib.os` and
`sys.modules` fail on the attribute, `__import__` and `getattr` fail on the name, and `yaml`
fails on the import, since `yaml.unsafe_load` can construct `os.system`. A program whose
text names a shell-startup, settings or hook file is never inert either. Such a program can
plant a command that a later shell runs, which no text rule here would see.

Typical usage example:

    if interpreter and not inert(body):
        ...  # read the body for an escalator, as before
"""

import ast
import builtins
import re

# Modules whose public API holds nothing that runs a process.
MODULES = frozenset(
    {
        "pathlib", "re", "json", "textwrap", "collections", "itertools", "functools",
        "difflib", "string", "fnmatch", "datetime", "math", "tomllib", "csv", "hashlib",
        "dataclasses", "typing", "enum", "pprint", "copy", "operator", "base64", "sys",
    }
)  # fmt: skip

# Every attribute an inert program may read that changes no file on any object. A name
# outside ATTRIBUTES refuses, whatever the object: the check has no types, so `x.system` is
# refused for every `x`. An attribute added here must be one no object in MODULES uses to
# write, create, move or delete a file; otherwise it belongs in FILE_CHANGING.
READ_ATTRIBUTES = frozenset(
    {
        # str
        "index", "rindex", "count", "split", "rsplit", "splitlines", "join",
        "strip", "lstrip", "rstrip", "startswith", "endswith", "find", "rfind", "format",
        "lower", "upper", "title", "capitalize", "partition", "rpartition", "removeprefix",
        "removesuffix", "ljust", "rjust", "center", "zfill", "isdigit", "isalpha",
        "isalnum", "isspace", "isupper", "islower", "encode", "decode", "expandtabs",
        # list, dict, set
        "append", "extend", "insert", "pop", "remove", "clear", "reverse", "sort",
        "items", "keys", "values", "get", "update", "setdefault", "add", "discard",
        "union", "intersection", "difference", "issubset", "issuperset",
        # pathlib and file objects
        "Path", "PurePath", "PurePosixPath", "read_text", "read_bytes", "exists",
        "is_file", "is_dir", "name", "stem", "suffix", "suffixes", "parent", "parents",
        "parts", "glob", "rglob", "iterdir", "read", "readlines", "close", "resolve",
        "relative_to", "with_suffix", "with_name", "with_stem", "joinpath", "as_posix",
        "stat", "st_size", "st_mtime",
        # re and match objects
        "sub", "subn", "search", "match", "fullmatch", "findall", "finditer", "compile",
        "escape", "group", "groups", "groupdict", "start", "end", "span", "pattern",
        "DOTALL", "MULTILINE", "IGNORECASE", "VERBOSE", "ASCII", "M", "S", "I", "X", "A",
        # json, textwrap, collections, itertools, functools, difflib
        "dumps", "loads", "load", "JSONDecodeError", "dedent", "indent", "fill",
        "wrap", "shorten", "Counter", "defaultdict", "OrderedDict", "deque", "namedtuple",
        "most_common", "elements", "chain", "from_iterable", "groupby", "product",
        "permutations", "combinations", "islice", "zip_longest", "accumulate", "pairwise",
        "reduce", "partial", "cache", "lru_cache", "wraps", "cmp_to_key", "unified_diff",
        "ndiff", "context_diff", "SequenceMatcher", "ratio", "get_opcodes",
        # datetime, hashlib, base64, math, dataclasses, enum
        "now", "today", "utcnow", "isoformat", "fromisoformat", "strftime", "strptime",
        "timedelta", "timezone", "utc", "date", "year", "month", "day", "timestamp",
        "sha256", "sha1", "md5", "hexdigest", "digest", "b64encode", "b64decode",
        "floor", "ceil", "sqrt", "inf", "dataclass", "field", "asdict", "Enum", "auto",
        # sys: the process's own arguments and streams, nothing that loads code
        "argv", "exit", "stdin", "stdout", "stderr",
    }
)  # fmt: skip

# Attributes that change a file on some object an inert program can hold. The check has no
# types, so `replace` and `copy` are here for `Path.replace` and `Path.copy` although `str`
# and `list` share the names, and `write` and `dump` are here although `sys.stdout` takes them.
# `open` is here too: `read_only` passes it only as a call that opens for reading.
FILE_CHANGING = frozenset(
    {
        "write_text", "write_bytes", "write", "writelines", "dump", "open", "mkdir",
        "touch", "unlink", "rename", "replace", "copy",
    }
)  # fmt: skip
ATTRIBUTES = READ_ATTRIBUTES | FILE_CHANGING

# Builtins an inert program may name. Every other builtin refuses, `open` excepted, which
# reads and writes files and starts nothing.
BUILTINS = frozenset(
    {
        "print", "len", "str", "int", "float", "bool", "list", "dict", "set", "tuple",
        "frozenset", "bytes", "sorted", "reversed", "range", "enumerate", "zip", "map",
        "filter", "any", "all", "min", "max", "sum", "abs", "round", "repr", "isinstance",
        "ord", "chr", "hex", "open", "divmod", "hash", "iter", "next", "slice", "format",
        "object", "Exception", "ValueError", "KeyError", "IndexError", "TypeError",
        "AssertionError", "RuntimeError", "FileNotFoundError", "OSError", "StopIteration",
        "SystemExit", "NotImplementedError", "True", "False", "None",
    }
)  # fmt: skip

# The files bash and zsh run at startup, login or logout. The alternation reads the same in
# Python `re` and in the ERE dialect of `deny.py`, whose `WRITE_TARGETS` refuses a shell
# write to the same names.
SHELL_STARTUP_FILES = (
    r"\.bashrc|\.bash_profile|\.bash_login|\.bash_logout|\.profile|"
    r"\.zshenv|\.zshrc|\.zprofile|\.zlogin|\.zlogout"
)

# Files that a later shell, ssh, git, systemd or Claude Code runs, a user-writable directory
# on PATH, and /proc, whose `self/mem` rewrites the running interpreter. A program that names
# one could plant a command there, so it is never inert. zsh reads `.zshenv` for every
# `zsh -c`, which is how each Bash call runs here; `.ssh/config` runs a `ProxyCommand`;
# `~/.config` holds git's XDG config and systemd user units; `.mcp.json` and `.claude.json`
# start MCP servers. A root-owned directory such as /etc or /usr/local/bin is not listed: an
# inert program starts no `sudo`, so it cannot write one.
_PLANTS = re.compile(
    rf"{SHELL_STARTUP_FILES}|"
    r"\.ssh/|\.config/|\.claude/settings|\.claude/hooks|\.claude\.json|\.mcp\.json|"
    r"\.git/hooks|\.git/config|\.gitconfig|crontab|/proc/|"
    r"\.local/bin|~/bin\b|/home/[^/\s]+/bin\b"
)
_BUILTIN_NAMES = frozenset(dir(builtins))


def _import_ok(node: ast.Import | ast.ImportFrom, attributes: frozenset[str]) -> bool:
    if isinstance(node, ast.ImportFrom):
        if node.level or node.module is None:
            return False
        if node.module.split(".")[0] not in MODULES:
            return False
        return all(a.name in attributes for a in node.names)
    return all(a.name.split(".")[0] in MODULES and "." not in a.name for a in node.names)


def inert(program: str) -> bool:
    """True when `program` parses as Python and can start no process.

    Args:
        program: The program text an interpreter runs: a heredoc body or a `-c` argument.

    Returns:
        False for any program this module cannot prove inert, including one that does not
        parse.
    """
    return not _PLANTS.search(program) and _within(_parsed(program), ATTRIBUTES)


def read_only(program: str) -> bool:
    """True when `program` parses as Python, can start no process and can change no file.

    Unlike `inert`, a program that names a shell-startup, settings or hook file can pass:
    reading one plants nothing. Every attribute must be in READ_ATTRIBUTES, and every `open`
    must be a call that opens for reading (`_opens_for_read`). An `open` that is passed,
    aliased or stored is refused, since the mode it is later called with is out of sight.

    Args:
        program: The program text an interpreter runs: a heredoc body or a `-c` argument.

    Returns:
        False for any program this module cannot prove read-only, including one that does
        not parse.
    """
    tree = _parsed(program)
    if not _within(tree, READ_ATTRIBUTES | {"open"}):
        return False
    read_opens = {
        id(node.func)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _opens_for_read(node)
    }
    return all(id(node) in read_opens for node in ast.walk(tree) if _is_open(node))


def _parsed(program: str) -> ast.Module | None:
    try:
        return ast.parse(program)
    except SyntaxError, ValueError:
        return None


def _is_open(node: ast.AST) -> bool:
    return (isinstance(node, ast.Name) and node.id == "open") or (
        isinstance(node, ast.Attribute) and node.attr == "open"
    )


# `open`'s keywords that leave the mode alone. `opener`, `closefd` and a `flag` are not here.
_OPEN_KEYWORDS = frozenset({"mode", "encoding", "errors", "newline", "buffering"})


def _read_mode(node: ast.expr) -> bool:
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and set(node.value) <= set("rbt")
    )


def _opens_for_read(call: ast.Call) -> bool:
    """Whether `call` is an `open` whose mode is provably a read, wherever the opener keeps it.

    The builtin takes the mode second, after the path. An `x.open(…)` has no type for `x`:
    `Path('f').open` takes the mode first, while `gzip.open`, `io.open`, `ZipFile.open` and
    the unbound `Path.open(p, 'w')` take the path first and the mode second. So an attribute
    call is read as both. Its second argument must be a read mode, and its first must be a
    string literal that Python would not accept as a writing mode. A `mode=` keyword must be
    a read mode for either opener. A starred argument, a `**` mapping, or a keyword outside
    `_OPEN_KEYWORDS` refuses, since each can carry a mode this check does not read.
    """
    if not _is_open(call.func):
        return False
    if any(isinstance(a, ast.Starred) for a in call.args):
        return False
    if any(k.arg not in _OPEN_KEYWORDS for k in call.keywords):
        return False
    modes = [k.value for k in call.keywords if k.arg == "mode"] + call.args[1:2]
    if not all(map(_read_mode, modes)):
        return False
    if isinstance(call.func, ast.Attribute) and call.args:
        first = call.args[0]
        if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
            return False
        letters = set(first.value)
        return not (letters <= set("rwxabt+") and letters & set("wxa+"))
    return True


def _within(tree: ast.Module | None, attributes: frozenset[str]) -> bool:
    """Whether `tree` parsed, and every import, attribute and name in it is on the allowlist,
    with `attributes` as the attributes it may read."""
    if tree is None:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.Import | ast.ImportFrom):
            if not _import_ok(node, attributes):
                return False
        elif isinstance(node, ast.Attribute):
            if node.attr not in attributes:
                return False
        elif isinstance(node, ast.Name):
            if not _name_ok(node.id):
                return False
        # A declaration only rebinds a name; every later use of it is a Name node, which the
        # arm above checks. Its names are strings, so they are checked here too: `global
        # __builtins__` would otherwise slip a dunder past that arm.
        elif isinstance(node, ast.Global | ast.Nonlocal) and not all(map(_name_ok, node.names)):
            return False
    return True


def _name_ok(name: str) -> bool:
    """Whether `name` is neither a dunder nor a builtin outside BUILTINS."""
    return not name.startswith("__") and (name not in _BUILTIN_NAMES or name in BUILTINS)
