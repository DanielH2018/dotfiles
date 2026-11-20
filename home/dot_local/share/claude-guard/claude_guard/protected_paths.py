"""Commands and file-tool calls that can change the files the guard itself rests on.

The protected set is the hooks Claude Code runs, the guard's package, the settings both
read, the tools on the user's PATH that the settings trust by name, and the files that
give a session its instructions and an agent its restrictions:

    ~/.claude/hooks/   ~/.local/share/claude-guard/   ~/.local/bin/
    ~/.claude/settings.json   ~/.claude/settings.local.json
    ~/.claude/agents/   ~/.claude/skills/   ~/.claude/rules/   ~/.claude/output-styles/

`DIRS` and `FILES` are the one definition. `writes_protected_path` reads a Bash command
against it, and `protects_file` reads the path an Edit, Write or NotebookEdit call names.
The ask rules in settings.permissions.json repeat it for a session whose hook cannot run,
and tests/test_protected_paths.py fails when they and this module disagree. `chezmoi
apply` deploys every managed file in the set from its source, so no session needs to
write one in place.

DECIDED: the rule refuses by default instead of listing write verbs. A command that names
a protected path as a word passes only when it cannot write the path:

  * `readonly.command_reads_only` proves it a read, or it is one of `_READ_TOOLS`;
  * the path is the program being run (`~/.local/bin/ghread pr view 1`);
  * it is `cp` and the path is one of its sources, or `ln -s` and the path is what the
    link points at. A later word of the same command that goes through the link is
    compared at its target, and a later command meets the link on disk;
  * it is `chezmoi`, which `apply_guard` judges;
  * it runs a program file the guard cannot read: an interpreter given a script, or a
    command spelled with a directory outside the system ones (`bin/deployed`,
    `./check.sh`). Such a program can write any path without naming it, so the name on
    its command line adds nothing.

An interpreter's inline program is read here too (`python3 -c`, `node -e`, a program in
a heredoc). One that spells a protected path in its text is refused, and so is an
interpreter given a protected path when its first word is an option, not a script. A
Python program passes when `inert_python.read_only` proves it changes no file, and
Python is refused over an operand only for such a `-c` program, so `python3 -m json.tool
<path>` passes. `deny.WRITE_TARGETS` does not list `~/.local/bin`, because the rules that read it
match a path named anywhere in the command, and running a tool by its full path is
ordinary. A sed script is read the same way: one that writes a file and spells a
protected path is refused.

Every other command is refused, so `cp`, `mv`, `install`, `ln`, `tee`, `dd`, `rsync`, an
editor, `chmod`, `rm`, `touch`, `curl -o` and a verb nobody listed are one case. A write
redirect onto a protected path is refused whatever the command is.

A word is resolved before it is compared. `~`, `~user`, `$HOME` and `${HOME}` stand for
the home directory and `$PWD` for the working directory. A relative word is joined to the
working directory, which a literal `cd` earlier in the command moves. A `*`, `?` or `[`
component matches as the shell would match it, and a brace list is expanded. A path that
does not match as text is resolved through the links on disk and compared again. A
`$NAME` that an earlier word of the command set to a path in or above the set, or that a
`for` list holding one binds, stands for that path. `deny.guard_file_write` also reads the
command with each literal `for` list value in place of its variable.

A path can reach a command as data the guard does not follow: through a pipe into `xargs`
or a `while read` loop, or in a variable set from a substitution. After a pipeline stage
names a protected path, a command given unseen arguments or an expansion passes only when
it is a read or a program the guard cannot read. So does a command that expands a
variable set from a substitution that names one.

A directory above the set (`~`, `~/.claude`, `~/.local`, `~/.local/share`) is named by too
many ordinary commands to refuse by default. It is refused for the verbs in `_TREE_VERBS`
only: one that moves, removes or re-modes the directory, a copy whose result lands in the
set (`cp -r /tmp/bin ~/.local`), a copy that merges into the directory, and an archive
unpacked there.

Not read: a path only an unset variable spells, a path a program builds from parts, the
file a link inside a protected directory points at (the install behind a `uv tool`
entry), a command that writes into the set without naming it (`uv tool install`),
arguments `xargs` reads from a file, and an archive unpacked in a working directory above
the set.

While the working directory is itself inside the set, every relative word names a path
there, so only a read passes until the command changes directory.
"""

import fnmatch
import os
import posixpath
import re
import shlex
import sys

from claude_guard import deny as d
from claude_guard.checks import sed
from claude_guard.readonly import command_reads_only
from claude_guard.segment import parse

RULE = "guard-file-write"
REASON = (
    "Blocked: this command can change a Claude Code hook, a claude-guard file, the settings "
    "the guard reads, a tool in ~/.local/bin, or an agent, skill, rule or output-style file "
    "under ~/.claude, and the guard cannot prove that it only reads them. Change the chezmoi "
    "source and run `chezmoi apply`, or ask the user to make the change. If the path is only "
    "text in a file you are changing, make the change with the Edit or Write tool instead."
)
FILE_RULE = "guard-file-edit"
FILE_REASON = (
    "Blocked: this file is a Claude Code hook, a claude-guard file, the settings the guard "
    "reads, a tool in ~/.local/bin, or an agent, skill, rule or output-style file under "
    "~/.claude. Sessions do not change the deployed copy. `chezmoi source-path <file>` names "
    "its source: change that (in your worktree's copy when you are in one) and run `chezmoi "
    "apply <file>`. For a file chezmoi does not manage, ask the user to make the change."
)

DIRS = (
    ".claude/hooks",
    ".local/bin",
    ".local/share/claude-guard",
    ".claude/agents",
    ".claude/skills",
    ".claude/rules",
    ".claude/output-styles",
)
FILES = (".claude/settings.json", ".claude/settings.local.json")

# macOS and Windows match a path whatever its case.
_CASELESS = sys.platform in ("darwin", "win32")
_SYSTEM_BIN_DIRS = frozenset({"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"})
_HOME_SPELLINGS = r"\$HOME|\$\{HOME[^}]*\}"
_PWD_WORD = re.compile(r"(\$PWD|\$\{PWD\})(?=/|$)")
_OPTION_VALUE = re.compile(r"(?:--?[A-Za-z][\w-]*|[A-Za-z_]+)=(.+)", re.DOTALL)
_BRACES = re.compile(r"\{([^{}]*,[^{}]*)\}")
_GLOB = re.compile(r"[*?\[]")
_DESCRIPTOR = re.compile(r"[0-9]+|-")
_VAR = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_KEPT_VARS = frozenset({"HOME", "PWD"})
_SUBSTITUTED_NAME = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=\"?(?:\$\(|`)")

_COPIERS = frozenset({"cp", "mv", "install", "ln", "rsync", "scp"})
_UNPACKERS = frozenset({"tar", "bsdtar", "unzip", "cpio", "7z", "unar"})
_TREE_VERBS = (
    _COPIERS
    | _UNPACKERS
    | {"rm", "rmdir", "unlink", "chmod", "chown", "chgrp", "chattr", "setfacl", "shred"}
)
_TARGET_DIR = ("-t", "--target-directory")
_SYMBOLIC = re.compile(r"-[A-Za-rt-z]*s[A-Za-z]*|--symbolic")
_EXTRACTS = re.compile(r"-?[A-Za-wyz]*x[A-Za-z]*|--extract|--get")
_REMOTE_SHELLS = frozenset({"ssh", "hl"})
_SSH_VALUE_OPTS = frozenset("-" + c for c in "BbcDEeFIiJLlmOoPpQRSWw")
# Commands that take a command line as one word of text.
_TEXT_RUNNERS = d._SHELLS | {
    "su", "watch", "script", "flock", "parallel", "systemd-run", "tmux", "screen", "at",
    "batch", "nohup", "timeout",
}  # fmt: skip
_UNSEEN_ARGUMENTS = frozenset({"xargs", "parallel"})
_CHDIR_OPTS = frozenset({"-C", "--chdir", "--directory", "--cwd"})
_LOOP_HEADS = frozenset({"while", "until", "for"})
_SOURCERS = frozenset({"source", "."})
_AWKS = frozenset({"awk", "gawk", "mawk", "nawk"})
_BINDERS = frozenset({"[[", "for", "select", "case", "read"})
_SCRIPT_SUFFIXES = (".py", ".sh")
_SHELL_COMMAND_OPT = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
# Tools of this repo that only read the files they are given.
_READ_TOOLS = frozenset({"jsonq", "rootq"})


class _Set:
    """The protected paths under one home directory, and the links one command makes."""

    def __init__(self, home: str):
        self.home = posixpath.normpath(home)
        roots = {self.home, os.path.realpath(self.home)}
        self.dirs = {tuple(f"{r}/{rel}".split("/")) for r in roots for rel in DIRS}
        self.files = {tuple(f"{r}/{rel}".split("/")) for r in roots for rel in FILES}
        for rel in DIRS:
            self.dirs.add(tuple(os.path.realpath(f"{self.home}/{rel}").split("/")))
        for rel in FILES:
            self.files.add(tuple(os.path.realpath(f"{self.home}/{rel}").split("/")))
        self.depth = min(len(r.split("/")) for r in roots)
        self.links: dict[str, str] = {}
        user = re.escape(posixpath.basename(self.home))
        self.home_word = re.compile(rf"(~(?:{user})?|{_HOME_SPELLINGS})(?=/|$)")
        spelled = "|".join(re.escape(r) for r in sorted(roots))
        names = "|".join(re.escape(rel) for rel in DIRS + FILES)
        in_dirs = "|".join(re.escape(rel) + r"/[\w.-]" for rel in DIRS)
        in_files = "|".join(re.escape(rel) + r"(?![\w.-])" for rel in FILES)
        at_home = rf"(?:~(?:{user})?|{_HOME_SPELLINGS}|{spelled})/"
        flags = re.IGNORECASE if _CASELESS else 0
        self.text = re.compile(rf"{at_home}(?:{names})(?![\w.-])", flags)
        # In a program's text a bare directory is most often a PATH entry, so a program
        # is matched on a protected file or a path under a protected directory.
        self.file_text = re.compile(rf"{at_home}(?:{in_dirs}|{in_files})", flags)

    def _relation(self, path: str) -> str | None:
        for link, target in self.links.items():
            if path == link or path.startswith(link + "/"):
                path = target + path[len(link) :]
        parts = tuple(path.split("/"))
        found = None
        for protected, is_dir in [(p, True) for p in self.dirs] + [(p, False) for p in self.files]:
            shared = min(len(parts), len(protected))
            if not all(_matches(parts[k], protected[k]) for k in range(shared)):
                continue
            if len(parts) == len(protected) or (is_dir and len(parts) > len(protected)):
                return "inside"
            if len(parts) < len(protected) and len(parts) >= self.depth:
                found = "above"
        return found

    def paths(self, word: str, cwd: str | None) -> list[str]:
        """The absolute paths `word` may name, one per brace alternative."""
        value = _OPTION_VALUE.fullmatch(word)
        found = []
        for candidate in _expand_braces(value.group(1) if value else word):
            path = self.home_word.sub(lambda _: self.home, candidate, count=1)
            if cwd:
                path = _PWD_WORD.sub(lambda _: cwd, path, count=1)
            if not path.startswith("/"):
                if not cwd or path.startswith("-"):
                    continue
                path = f"{cwd}/{path}"
            found.append(posixpath.normpath(path))
        return found

    def link(self, argv: list[str], cwd: str | None) -> None:
        """Record what the symbolic link `ln -s` makes in `argv` points at, so a later word
        of the same command that goes through the link is compared at its target."""
        dest, sources = _destination(argv)
        if dest is None or len(sources) != 1:
            return
        for target in self.paths(argv[sources[0]], cwd):
            if self._relation(target) is None:
                continue
            for made in self.paths(argv[dest], cwd):
                self.links[made] = target
                self.links[f"{made}/{posixpath.basename(target)}"] = target

    def relation(self, word: str, cwd: str | None) -> str | None:
        """ "inside" when `word` names a protected path or one under a protected directory,
        "above" when it names a directory that holds one, else None."""
        found = None
        for path in self.paths(word, cwd):
            relation = self._relation(path) or self._relation(_resolved(path))
            if relation == "inside":
                return relation
            found = found or relation
        return found

    def named_in(self, text: str, cwd: str | None) -> bool:
        """Whether any word of the shell `text` names a path in or above the set."""
        words = d._words(text)
        if words is None:
            return self.text.search(text) is not None
        return any(self.relation(w.strip("()"), cwd) for w in words)


def _resolved(path: str) -> str:
    """`path` through the links on disk, or unchanged when it is no single literal path."""
    if _GLOB.search(path) or "$" in path or any(c.isspace() for c in path):
        return path
    try:
        return os.path.realpath(path)
    except OSError, ValueError:
        return path


def _matches(part: str, protected: str) -> bool:
    if _CASELESS:
        part, protected = part.lower(), protected.lower()
    if part == protected:
        return True
    return bool(_GLOB.search(part)) and fnmatch.fnmatchcase(protected, part)


def _expand_braces(word: str) -> list[str]:
    words = [word]
    for _ in range(4):
        expanded = []
        for w in words:
            m = _BRACES.search(w)
            if m is None:
                expanded.append(w)
                continue
            expanded += [w[: m.start()] + alt + w[m.end() :] for alt in m.group(1).split(",")]
        if expanded == words or len(expanded) > 64:
            break
        words = expanded
    return words


def _simple_commands(words: list[str]) -> tuple[list[list[str]], list[str]]:
    """The simple commands in a segment's `words`, and the words a redirect writes to."""
    commands: list[list[str]] = [[]]
    written: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        i += 1
        if w and set(w) <= set(";&|()<>"):
            if not set(w) & set("<>"):
                commands.append([])
                continue
            if commands[-1] and commands[-1][-1].isdigit():
                commands[-1].pop()
            if i < len(words):
                if ">" in w and not _DESCRIPTOR.fullmatch(words[i]):
                    written.append(words[i])
                i += 1
            continue
        commands[-1].append(w)
    return [c for c in commands if c], written


def _destination(argv: list[str]) -> tuple[int | None, list[int]]:
    """The index of a copier's destination word and the indices of its sources."""
    operands = []
    target = None
    i = 1
    while i < len(argv):
        w = argv[i]
        if w == "--":
            operands += range(i + 1, len(argv))
            break
        if w in _TARGET_DIR and i + 1 < len(argv):
            target = i + 1
            i += 2
            continue
        if w.startswith("--target-directory=") or (w.startswith("-t") and len(w) > 2):
            target = i
        elif not w.startswith("-") or w == "-":
            operands.append(i)
        i += 1
    if target is not None:
        return target, operands
    if not operands:
        return None, []
    return operands[-1], operands[:-1]


def _lands_in_set(argv: list[str], protected: _Set, cwd: str | None) -> bool:
    """Whether a copier writes into the set through a destination directory above it."""
    dest, sources = _destination(argv)
    if dest is None or protected.relation(argv[dest], cwd) != "above":
        return False
    if any(w in ("-T", "--no-target-directory") for w in argv[1:]):
        return True
    for i in sources:
        source = argv[i]
        if source.endswith(("/", "/.")) or _GLOB.search(posixpath.basename(source)):
            return True
        landed = f"{argv[dest].rstrip('/')}/{posixpath.basename(source)}"
        if protected.relation(landed, cwd) is not None:
            return True
    return False


def _reads_only(argv: list[str]) -> bool:
    """Whether `argv` cannot write the words it names: a read the verb tables prove, a
    test, the header of a loop, or a builtin that only binds a name."""
    if argv[0] in _BINDERS or argv[0] in d._EXPORTERS or argv[0] in _READ_TOOLS:
        return True
    return command_reads_only(shlex.join(argv))


def _unreadable_program(argv: list[str]) -> bool:
    """Whether `argv` runs a program whose writes no command line shows.

    An awk program is left out, because its operands are files it can edit in place. A
    shell counts when it runs a script file, not a `-c` string. An interpreter whose inline
    program no deny rule reads (`lua -e`) counts only when its first word is the script."""
    head, _, name = argv[0].rpartition("/")
    if (head and head not in _SYSTEM_BIN_DIRS) or name.endswith(_SCRIPT_SUFFIXES):
        return True
    if name in _SOURCERS:
        return True
    if name in _AWKS:
        return False
    if d._PYTHON_WORD.fullmatch(name) or d._stdin_cli(name) is not None:
        return True
    if name in d._SHELLS:
        return not any(_SHELL_COMMAND_OPT.fullmatch(a) for a in argv[1:])
    return d._is_interpreter(name) and len(argv) > 1 and not argv[1].startswith("-")


def _cannot_write(argv: list[str]) -> bool:
    return _unreadable_program(argv) or _reads_only(argv)


def _inline_programs(argv: list[str]) -> list[str] | None:
    """The program texts the interpreter `argv` is given on its command line, or None when
    `argv` runs no interpreter the guard reads inline programs for. An option's value
    counts as a program when it holds whitespace or a call, which is what tells
    `-c 'open(p)'` from `-W ignore`."""
    name = posixpath.basename(argv[0])
    if not (d._PYTHON_WORD.fullmatch(name) or d._stdin_cli(name) or d._is_interpreter(name)):
        return None
    if name in _AWKS:
        return None
    return [
        a
        for prev, a in zip(argv, argv[1:], strict=False)
        if prev.startswith("-") and (any(c.isspace() for c in a) or "(" in a)
    ]


def _program_writes(name: str, program: str, protected: _Set) -> bool:
    if not protected.file_text.search(program):
        return False
    return not (d._PYTHON_WORD.fullmatch(name) and d.read_only(program))


def _remote_payloads(argv: list[str]) -> list[str]:
    quoted = [a for a in argv[1:] if any(c.isspace() for c in a)]
    if quoted:
        return quoted
    i = 1
    while i < len(argv) and argv[i].startswith("-"):
        i += 2 if argv[i] in _SSH_VALUE_OPTS else 1
    return [shlex.join(argv[i + 1 :])] if len(argv) > i + 1 else []


def _command_writes(
    argv: list[str], protected: _Set, cwd: str | None, fed: bool, depth: int
) -> bool:
    """Whether the simple command `argv` may change a protected path. `fed` says that data
    naming one reaches this command where the guard cannot follow it."""
    if not argv:
        return False
    name = posixpath.basename(argv[0])
    if name in _REMOTE_SHELLS:
        return any(_writes(t, protected, None, depth + 1) for t in _remote_payloads(argv))
    if name in _TEXT_RUNNERS:
        texts = [a for a in argv[1:] if any(c.isspace() for c in a)]
        if name == "eval":
            texts = [" ".join(argv[1:])]
        if any(_writes(t, protected, cwd, depth + 1) for t in texts):
            return True
    tails = [t for t in d._command_tails(argv) if t]
    if tails:
        for tail in tails:
            leader = argv[: len(argv) - len(tail)]
            unseen = fed and name in _UNSEEN_ARGUMENTS
            where = cwd
            for option, value in zip(leader, leader[1:], strict=False):
                if option in _CHDIR_OPTS and len(protected.paths(value, cwd)) == 1:
                    where = protected.paths(value, cwd)[0]
            if unseen and not command_reads_only(shlex.join(tail), unseen_arguments=True):
                return True
            if _command_writes(tail, protected, where, fed, depth):
                return True
        return False
    relations = [protected.relation(w, cwd) for w in argv]
    programs = _inline_programs(argv)
    if programs is not None:
        if any(_program_writes(name, text, protected) for text in programs):
            return True
        if d._PYTHON_WORD.fullmatch(name):
            unproven = any(not d.read_only(text) for text in programs)
        else:
            unproven = len(argv) > 1 and argv[1].startswith("-")
        if unproven and "inside" in relations[1:] and not _reads_only(argv):
            return True
    if name in sed.SED_NAMES:
        script = "\n".join(sed.scripts(argv[1:]) or [])
        found = sed.effects(script)
        if protected.file_text.search(script) and (found is None or sed.WRITE in found):
            return True
    run = relations[0] == "inside"
    inside = {i for i, r in enumerate(relations) if r == "inside" and i > 0}
    linking = name == "ln" and any(_SYMBOLIC.fullmatch(a) for a in argv[1:])
    dest, _ = _destination(argv)
    if name == "cp" or linking:
        inside &= {dest}
    judged = [name, *argv[1:]] if run else argv
    written = [argv[dest]] if (name == "cp" or linking) and dest is not None else argv[1:]
    expands = fed and any("$" in a for a in written)
    if (inside or expands) and name != "chezmoi" and not _cannot_write(judged):
        return True
    if linking:
        protected.link(argv, cwd)
    if name not in _TREE_VERBS or "above" not in relations[1:]:
        return False
    if name in _COPIERS:
        _, sources = _destination(argv)
        moves = name == "mv" or (name == "ln" and not linking)
        if moves and any(relations[i] == "above" for i in sources):
            return True
        return _lands_in_set(argv, protected, cwd)
    if name in _UNPACKERS:
        return name != "tar" or any(_EXTRACTS.fullmatch(a) for a in argv[1:])
    return True


def _moved(argv: list[str], cwd: str | None, protected: _Set) -> str | None:
    """The working directory after the `cd` in `argv`, or None when it cannot be read."""
    operands = [a for a in argv[1:] if not a.startswith("-") or a == "-"]
    if not operands:
        return protected.home
    if operands[0] == "-" or _GLOB.search(operands[0]):
        return None
    paths = protected.paths(operands[0], cwd)
    return paths[0] if len(paths) == 1 and "$" not in paths[0] else None


def _bind(words: list[str], bound: dict[str, str], protected: _Set, cwd: str | None) -> None:
    """Record each name `words` set to a path in or above the set: `NAME=path`, behind
    `export` or not, and the variable of a `for` loop whose list holds one."""
    values = [w.partition("=") for w in words]
    if len(words) > 3 and words[0] == "for" and words[2] == "in":
        values = [(words[1], "=", w) for w in words[3:]]
    for name, eq, value in values:
        binds = eq and d._NAME.fullmatch(name) and name not in bound
        if binds and protected.relation(value, cwd):
            bound[name] = protected.paths(value, cwd)[0]


def _writes(text: str, protected: _Set, cwd: str | None, depth: int = 0) -> bool:
    p = parse(text)
    if not p.ok or depth > 4:
        return protected.text.search(text) is not None
    segment_words = [d._words(seg.text) for seg in p.segments]
    runs_lines = any(
        posixpath.basename(w) in d._LINE_RUNNERS and w != "." or i == 0 and w == "."
        for words in segment_words
        for i, w in enumerate(words or [])
    )
    piped = looping = False
    fed_names: set[str] = set()
    bound: dict[str, str] = {}
    for seg, words in zip(p.segments, segment_words, strict=True):
        if words is None:
            if protected.text.search(seg.text):
                return True
            continue

        def value(m: re.Match[str]) -> str:
            name = m.group(1) or m.group(2)
            return m.group() if name in _KEPT_VARS else bound.get(name, m.group())

        words = [_VAR.sub(value, w) for w in words]
        if protected.text.search(seg.text):
            fed_names |= {m.group(1) for m in _SUBSTITUTED_NAME.finditer(seg.text)}
        _bind(words, bound, protected, cwd)
        commands, written = _simple_commands(words)
        if any(protected.relation(w, cwd) == "inside" for w in written):
            return True
        named = False
        for command in commands:
            argv = d._argv(command)
            fed = piped or any(
                (m.group(1) or m.group(2)) in fed_names for w in argv for m in _VAR.finditer(w)
            )
            if _command_writes(argv, protected, cwd, fed, depth):
                return True
            named |= any(protected.relation(w, cwd) for w in argv)
            if argv and argv[0] in ("cd", "pushd"):
                cwd = _moved(argv, cwd, protected)
        head = commands[0][0] if commands else ""
        looping = piped and (head in _LOOP_HEADS or (looping and head != "done"))
        piped = (piped or named) if seg.sep == "|" else looping
        owner = posixpath.basename(((d._argv(commands[0]) if commands else []) or [""])[0])
        interpreter = d._is_interpreter(owner) or d._stdin_cli(owner) is not None
        if interpreter and any(_program_writes(owner, b, protected) for b in seg.heredocs):
            return True
        as_shell = runs_lines and not interpreter
        if as_shell and any(_writes(body, protected, cwd, depth + 1) for body in seg.heredocs):
            return True
    return any(_writes(body, protected, None, depth + 1) for body in p.substitutions)


def protects_file(path: str, cwd: str, home: str) -> bool:
    """Whether `path`, as a file tool names it, is a protected path under `home`.

    A relative `path` is joined to `cwd`. The path is compared as written and through the
    links on disk, so a file reached through a linked directory counts."""
    if not home or not path:
        return False
    if not path.startswith("/"):
        path = f"{cwd}/{path}"
    path = posixpath.normpath(path)
    protected = _Set(home)
    try:
        real = os.path.realpath(path)
    except OSError, ValueError:
        real = path
    return "inside" in (protected._relation(path), protected._relation(real))


def writes_protected_path(command: str, cwd: str, home: str) -> bool:
    """Whether `command`, run in `cwd`, may change a protected path under `home`.

    An empty `cwd` leaves a relative word unresolved, so only a word spelled from the home
    directory or the root is compared."""
    if not home:
        return False
    return _writes(command, _Set(home), posixpath.normpath(cwd) if cwd else None)
