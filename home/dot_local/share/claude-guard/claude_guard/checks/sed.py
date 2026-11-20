"""sed scripts that run a shell command, for the `Bash(sed:*)` allow rule.

GNU sed runs a command two ways, and neither names a shell on the command line:

    e [command]      run `command`, or the pattern space when no command follows
    s/re/text/e      run the pattern space after the substitution

`sed_risk` reads one command line and returns `EXEC` for a script that holds either form,
`UNREAD` for a script it cannot read, and None otherwise. A script it cannot read is one
that comes from a file (`-f`), one given through an option it cannot spell out, and one
whose text does not parse as sed commands. `--sandbox` makes sed itself reject the two
forms, so a sed given that option is not read.

DECIDED: `effects` parses the script instead of scanning it for the letter. The text after
`a`, `i` and `c`, a label, a file name after `r` or `w`, and both halves of `s` and `y`
are data, and an `e` inside any of them runs nothing. A parser that stops at the first
word it cannot place refuses, so a gap in it denies and never passes.

A `$NAME`, `${NAME}` or `$( )` where an address may stand is read as a line number, which
is how `sed -n "${n}p"` is written. A script that is nothing but an expansion is not read.
A `$` inside single quotes is sed's own last-line address, so `_words` marks it before
the quotes are dropped and `'$a text'` appends text. A value an expansion yields is not
read, so one that carries its own `e` command is out of reach.

`checks/remote_guards.py` holds a second, coarser reader for the allow side. It refuses
`r`, `w` and every `e` it finds by scanning, which suits a proof that a command only reads.
"""

import posixpath
import re
import shlex

from claude_guard.segment import mask_substitutions, parse

RULE = "sed-exec"
SED_NAMES = frozenset({"sed", "gsed"})

_LONG = (
    "--expression", "--file", "--in-place", "--quiet", "--silent", "--debug", "--posix",
    "--regexp-extended", "--separate", "--sandbox", "--unbuffered", "--null-data",
    "--zero-terminated", "--line-length", "--follow-symlinks", "--help", "--version",
)  # fmt: skip
_EXPANSION = re.compile(r"\$\{[^}]*\}|\$[0-9@#?*]|\$[A-Za-z_]\w*")
_ONE_LETTER = frozenset("=dDgGhHnNpPxzF")
_TEXT_TO_EOL = frozenset("aic")
_FILE_TO_EOL = frozenset("rRwW")
_LABEL = frozenset("btT")
_COUNT = frozenset("qQlL")
_S_FLAGS = frozenset("gpIiMme0123456789")

EXEC = "exec"
WRITE = "write"
UNREAD = "unread"
# Stands for a substitution in a word, and reads as an expansion.
_SUBSTITUTION = "${CLAUDE_GUARD_SUB}"
# Stands for a `$` the shell leaves alone, which sed reads as the last line.
LAST_LINE = "\ue000"

_KEYWORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"})
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=")
# Commands that take a command line as one word of text.
_TEXT_RUNNERS = frozenset(
    {
        "sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "eval", "ssh", "hl", "su", "watch",
        "script", "flock", "parallel", "systemd-run", "at", "batch", "tmux",
    }
)  # fmt: skip
# Commands that run the words after them, so a sed among those words is one that runs.
_LEADERS = _TEXT_RUNNERS | frozenset(
    {
        "env", "command", "builtin", "exec", "nohup", "setsid", "time", "nice", "ionice",
        "timeout", "stdbuf", "xargs", "sudo", "doas", "busybox", "strace", "unbuffer",
        "chroot", "nsenter", "unshare", "taskset", "chrt", "runuser",
    }
)  # fmt: skip


def _skip_field(script: str, i: int, delim: str, brackets: bool = False) -> int | None:
    """The index after the next unescaped `delim` from `i`, or None when there is none.
    With `brackets`, a `delim` inside a `[…]` expression does not end the field."""
    while i < len(script):
        if script[i] == "\\":
            i += 2
            continue
        if brackets and script[i] == "[" and delim != "[":
            close = script.find("]", i + (3 if script.startswith("[^]", i) else 2))
            if close < 0:
                return None
            i = close + 1
            continue
        if script[i] == "\n" and delim != "\n":
            return None
        if script[i] == delim:
            return i + 1
        i += 1
    return None


def _eol(script: str, i: int) -> int:
    """The index of the newline that ends the line at `i`, past each escaped newline."""
    while i < len(script) and script[i] != "\n":
        i += 2 if script[i] == "\\" else 1
    return min(i, len(script))


def _address(script: str, i: int, brackets: bool) -> int | None:
    """The index after one address at `i`, `i` itself when none stands there, or None when
    a regex address does not end."""
    if i >= len(script):
        return i
    expansion = _EXPANSION.match(script, i)
    if expansion:
        return expansion.end()
    c = script[i]
    if c.isdigit():
        while i < len(script) and (script[i].isdigit() or script[i] == "~"):
            i += 1
        return i
    if c in ("$", LAST_LINE):
        return i + 1
    if c == "/" or (c == "\\" and i + 1 < len(script)):
        delim = "/" if c == "/" else script[i + 1]
        end = _skip_field(script, i + 1 if c == "/" else i + 2, delim, brackets)
        if end is None:
            return None
        while end < len(script) and script[end] in "IM":
            end += 1
        return end
    return i


def effects(script: str) -> frozenset[str] | None:
    """What a sed `script` does beside editing its pattern space: `EXEC` when it runs a
    command, `WRITE` when it writes a file. None when the script does not parse.

    GNU sed reads a delimiter inside a `[…]` expression as text and other seds end the
    regex there, so the script is read both ways and the findings are joined."""
    readings = [r for r in (_effects(script, True), _effects(script, False)) if r is not None]
    return frozenset().union(*readings) if readings else None


def _effects(script: str, brackets: bool) -> set[str] | None:
    found: set[str] = set()
    i, n = 0, len(script)
    while i < n:
        c = script[i]
        if c in " \t\n;{}":
            i += 1
            continue
        if c == "#":
            i = _eol(script, i)
            continue
        if c == ":":
            while i < n and script[i] not in ";\n":
                i += 1
            continue
        start = i
        i = _address(script, i, brackets)
        if i is None:
            return None
        if i != start:
            while i < n and script[i] in " \t":
                i += 1
            if i < n and script[i] == ",":
                i += 1
                while i < n and script[i] in " \t+~":
                    i += 1
                i = _address(script, i, brackets)
                if i is None:
                    return None
            while i < n and script[i] in " \t!":
                i += 1
            if i >= n:
                return None
            if script[i] == "{":
                continue
            if script[i] in ";\n}":
                return None
            c = script[i]
        elif c == "!":
            i += 1
            continue
        if c in _ONE_LETTER:
            i += 1
        elif c in _TEXT_TO_EOL:
            i = _eol(script, i + 1)
        elif c in _FILE_TO_EOL:
            if c in "wW":
                found.add(WRITE)
            i = _eol(script, i + 1)
        elif c in _LABEL:
            i += 1
            while i < n and script[i] not in ";\n}":
                i += 1
        elif c in _COUNT or c == "v":
            i += 1
            while i < n and script[i] not in ";\n}":
                if not (script[i].isalnum() or script[i] in " \t."):
                    return None
                i += 1
        elif c == "e":
            found.add(EXEC)
            i = _eol(script, i + 1)
        elif c in "sy":
            if i + 1 >= n or script[i + 1] in "\n\\":
                return None
            delim = script[i + 1]
            i = _skip_field(script, i + 2, delim, brackets)
            i = None if i is None else _skip_field(script, i, delim)
            if i is None:
                return None
            while c == "s" and i < n and script[i] not in " \t\n;}":
                flag = script[i]
                if flag == "e":
                    found.add(EXEC)
                elif flag == "w":
                    found.add(WRITE)
                    i = _eol(script, i) - 1
                elif flag not in _S_FLAGS:
                    return None
                i += 1
        else:
            return None
    return found


def _long_name(word: str) -> str | None:
    """The long option `word` spells or abbreviates, or None when it names none or several."""
    name = word.split("=", 1)[0]
    matches = [full for full in _LONG if full.startswith(name)]
    if name in matches:
        return name
    if "--quiet" in matches or "--silent" in matches:
        matches = [m for m in matches if m not in ("--quiet", "--silent")] or ["--quiet"]
    return matches[0] if len(matches) == 1 else None


def scripts(args: list[str]) -> list[str] | None:
    """The script fragments a sed is given in the words `args` after its name, or None when
    the script is not on the command line or the options cannot be read. Empty under
    `--sandbox`, where sed rejects every command this module looks for."""
    found: list[str] = []
    positional: list[str] = []
    given = False
    i = 0
    while i < len(args):
        a = args[i]
        i += 1
        if a == "--":
            positional += args[i:]
            break
        if a.startswith("--"):
            name = _long_name(a)
            if name is None or name == "--file":
                return None
            if name == "--sandbox":
                return []
            if name in ("--expression", "--line-length") and "=" not in a:
                if i >= len(args):
                    return None
                a, i = f"{name}={args[i]}", i + 1
            if name == "--expression":
                found.append(a.split("=", 1)[1])
                given = True
            continue
        if a.startswith("-") and len(a) > 1:
            for j, letter in enumerate(a[1:], 2):
                if letter == "f":
                    return None
                if letter in "iI":
                    break
                if letter in "el":
                    value = a[j:]
                    if not value:
                        if i >= len(args):
                            return None
                        value, i = args[i], i + 1
                    if letter == "e":
                        found.append(value)
                        given = True
                    break
            continue
        positional.append(a)
    if not given:
        if not positional:
            return None
        found.append(positional[0])
    return found


def _mark_last_line(text: str) -> str:
    """`text` with each `$` inside single quotes replaced by `LAST_LINE`."""
    out: list[str] = []
    quote = ""
    i = 0
    while i < len(text):
        c = text[i]
        if quote != "'" and c == "\\" and i + 1 < len(text):
            out.append(text[i : i + 2])
            i += 2
            continue
        if c in "'\"" and not quote:
            quote = c
        elif c == quote:
            quote = ""
        out.append(LAST_LINE if c == "$" and quote == "'" else c)
        i += 1
    return "".join(out)


def _words(text: str) -> list[str] | None:
    text = mask_substitutions(text, _SUBSTITUTION) or text
    lex = shlex.shlex(_mark_last_line(text), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        return list(lex)
    except ValueError:
        return None


def _simple_commands(words: list[str]) -> list[list[str]]:
    """The simple commands in a segment's `words`, each without its redirects."""
    commands: list[list[str]] = [[]]
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
            i += 1
            continue
        commands[-1].append(w)
    return commands


def _sed_risk(args: list[str]) -> str | None:
    given = scripts(args)
    if given is None:
        return UNREAD
    script = "\n".join(given)
    found = None if _EXPANSION.fullmatch(script.strip()) else effects(script)
    if given and found is None:
        return UNREAD
    if found and EXEC in found:
        return EXEC
    return None


def _command_risk(argv: list[str], depth: int) -> str | None:
    """The risk of the sed that `argv` runs: as its command word, behind a leader that
    execs its arguments, or inside a command line a shell word is given as text."""
    while argv and (argv[0] in _KEYWORDS or _ASSIGNMENT.match(argv[0])):
        argv = argv[1:]
    if not argv:
        return None
    head = posixpath.basename(argv[0])
    if head in SED_NAMES:
        return _sed_risk(argv[1:])
    if head not in _LEADERS:
        return None
    for i, w in enumerate(argv[1:], 1):
        if posixpath.basename(w) in SED_NAMES:
            return _sed_risk(argv[i + 1 :])
        if head in _TEXT_RUNNERS and any(c.isspace() for c in w):
            inner = _risk(w, depth + 1)
            if inner:
                return inner
    return None


def _risk(text: str, depth: int) -> str | None:
    p = parse(text)
    if not p.ok or depth > 4:
        return None
    bodies: list[str] = []
    for seg in p.segments:
        for argv in _simple_commands(_words(seg.text) or []):
            risk = _command_risk(argv, depth)
            if risk:
                return risk
            if any(posixpath.basename(w) in _TEXT_RUNNERS for w in argv):
                bodies += seg.heredocs
    for body in [*bodies, *p.substitutions]:
        inner = _risk(body, depth + 1)
        if inner:
            return inner
    return None


def sed_risk(command: str) -> str | None:
    """`EXEC` when a sed in `command` runs a shell command from its script, `UNREAD` when
    one is given a script the guard cannot read, else None. A sed is found as a command
    word, behind a leader that execs its arguments, in a command line a shell is given as
    text or as a heredoc, and in a substitution."""
    if "sed" not in command:
        return None
    return _risk(command, 0)
