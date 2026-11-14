"""Whether a Bash command only reads files and prints text, so none of its words can run.

`only_reads_or_prints` is an allowlist. It answers True only when it can read every word of
every segment and each segment is one of:

    grep, egrep, fgrep        any arguments; no grep option runs a program
    rg                        options from `_RG_BARE` and `_RG_VALUED` only, which leaves out
                              `--pre`, `--hostname-bin` and `--search-zip`
    echo                      any arguments
    printf                    a format first, never an option (`-v NAME` assigns a variable)
                              and never a glob, which could expand to one
    head tail wc cat cut tr nl    any arguments

Anything else is False: a command name spelled as a path or behind an assignment, any
expansion or substitution, a heredoc, a subshell or group, backgrounding, and every redirect
except `>/dev/null`, `2>/dev/null`, `>&1` and `>&2` written as one unquoted word. Quoted
text joined to a redirect (`>'x'`, `>/dev/null'x'`) is part of the redirect's target, so it
is refused with the rest. False means "not proven", never "runs something".

`printed` reads the text an `echo` or a `printf` segment writes, for a rule that judges what
the next command of a pipe is fed.
"""

import re

from claude_guard.segment import Segment, parse

_ANY_ARGS = frozenset(
    {"grep", "egrep", "fgrep", "echo", "head", "tail", "wc", "cat", "cut", "tr", "nl"}
)
_SEPARATORS = frozenset({"&&", "||", ";", "|", "newline", "eof"})

_RG_BARE_SHORT = frozenset("sFivxUPSawL.ubnN0opqHIclhV")
_RG_VALUED_SHORT = frozenset("efgtTABCmMjErd")
_RG_BARE = frozenset(
    [
        "case-sensitive",
        "crlf",
        "fixed-strings",
        "ignore-case",
        "invert-match",
        "line-regexp",
        "multiline",
        "multiline-dotall",
        "no-unicode",
        "null-data",
        "pcre2",
        "smart-case",
        "text",
        "word-regexp",
        "follow",
        "hidden",
        "glob-case-insensitive",
        "no-ignore",
        "no-ignore-vcs",
        "no-ignore-parent",
        "no-ignore-dot",
        "no-ignore-global",
        "no-ignore-files",
        "no-ignore-exclude",
        "no-ignore-messages",
        "no-require-git",
        "one-file-system",
        "unrestricted",
        "binary",
        "byte-offset",
        "column",
        "heading",
        "no-heading",
        "line-number",
        "no-line-number",
        "null",
        "files",
        "only-matching",
        "passthru",
        "pretty",
        "quiet",
        "trim",
        "vimgrep",
        "with-filename",
        "no-filename",
        "count",
        "count-matches",
        "files-with-matches",
        "files-without-match",
        "json",
        "no-messages",
        "stats",
        "no-config",
        "type-list",
        "version",
        "help",
        "sort-files",
        "include-zero",
    ]
)
_RG_VALUED = frozenset(
    [
        "regexp",
        "file",
        "glob",
        "iglob",
        "type",
        "type-not",
        "type-add",
        "after-context",
        "before-context",
        "context",
        "max-count",
        "max-columns",
        "max-depth",
        "threads",
        "encoding",
        "replace",
        "color",
        "colors",
        "sort",
        "sortr",
        "max-filesize",
        "engine",
        "context-separator",
        "ignore-file",
    ]
)

_QUIET_REDIRECT = re.compile(r">(?:[ \t]*/dev/null|&[12])(?=[ \t]|\Z)")
_REFUSED_BARE = frozenset("$`();&|<{}")
_DQUOTE_ESCAPABLE = frozenset('"\\$`')
_LITERAL_DOLLAR_BEFORE = frozenset('" )|')
_GLOB = frozenset("*?[")


def _words(text: str) -> list[tuple[str, bool]] | None:
    """The words of one segment as `(text, has_unquoted_glob)`, or None when the segment holds
    anything outside the module docstring's grammar. An allowed redirect yields no word."""
    words: list[tuple[str, bool]] = []
    cur: list[str] | None = None
    glob = quoted = False

    def end() -> None:
        nonlocal cur, glob, quoted
        if cur is not None:
            words.append(("".join(cur), glob))
        cur, glob, quoted = None, False, False

    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t":
            end()
            i += 1
        elif c == "'":
            close = text.find("'", i + 1)
            if close == -1:
                return None
            cur = (cur or []) + [text[i + 1 : close]]
            quoted = True
            i = close + 1
        elif c == '"':
            cur = cur or []
            quoted = True
            i += 1
            while i < n and text[i] != '"':
                d = text[i]
                nxt = text[i + 1 : i + 2]
                if d == "`" or (d == "$" and nxt not in _LITERAL_DOLLAR_BEFORE):
                    return None
                if d == "\\":
                    if nxt in ("", "\n"):
                        return None
                    cur.append(nxt if nxt in _DQUOTE_ESCAPABLE else d + nxt)
                    i += 2
                else:
                    cur.append(d)
                    i += 1
            if i == n:
                return None
            i += 1
        elif c == "\\":
            if text[i + 1 : i + 2] in ("", "\n"):
                return None
            cur = (cur or []) + [text[i + 1]]
            i += 2
        elif c == ">":
            m = _QUIET_REDIRECT.match(text, i)
            if m is None:
                return None
            if cur is not None and not quoted and "".join(cur) in ("1", "2"):
                cur = None
            end()
            i = m.end()
        elif c in _REFUSED_BARE or ord(c) < 32 or (c == "#" and cur is None):
            return None
        else:
            cur = (cur or []) + [c]
            glob = glob or c in _GLOB
            i += 1
    end()
    return words


def _rg_reads_only(args: list[tuple[str, bool]]) -> bool:
    """Whether every rg option in `args` is on the allowlist. A glob before `--` could expand
    to an option, so it is refused there."""
    i = 0
    while i < len(args):
        arg, glob = args[i]
        value_follows = False
        if arg == "--":
            return True
        if glob:
            return False
        if arg.startswith("--"):
            name, eq, _ = arg[2:].partition("=")
            if name in _RG_VALUED:
                value_follows = not eq
            elif name not in _RG_BARE or eq:
                return False
        elif arg.startswith("-") and len(arg) > 1:
            for j, letter in enumerate(arg[1:], start=1):
                if letter in _RG_VALUED_SHORT:
                    value_follows = j == len(arg) - 1
                    break
                if letter not in _RG_BARE_SHORT:
                    return False
        if value_follows:
            i += 1
            if i < len(args) and args[i][1]:
                return False
        i += 1
    return True


def _segment_reads_or_prints(text: str) -> bool:
    words = _words(text)
    if words is None:
        return False
    if not words:
        return True
    (name, glob), args = words[0], words[1:]
    if glob:
        return False
    if name in _ANY_ARGS:
        return True
    if name == "rg":
        return _rg_reads_only(args)
    if name == "printf":
        if not args:
            return True
        first, first_glob = args[0]
        return not first_glob and (first == "--" or not first.startswith("-"))
    return False


_ECHO_FLAGS = re.compile(r"-[neE]+")


def printed(text: str) -> str | None:
    r"""The text the segment `text` writes to stdout when it is one `echo` or `printf`.

    None means the text cannot be read from the words: another command, a word outside
    `_words`' grammar, a glob, or a backslash that `echo` or `printf` may turn into another
    character. `echo` joins its operands with a space after any `-n`, `-e` and `-E` flags.
    `printf` is read in two shapes: a format of `%s` or `%s\n` with its arguments, and a
    format with no `%` and no escape but `\n`, alone.
    """
    words = _words(text)
    if not words or any(glob for _, glob in words):
        return None
    name, *args = (word for word, _ in words)
    if name == "echo":
        while args and _ECHO_FLAGS.fullmatch(args[0]):
            del args[0]
        return None if any("\\" in a for a in args) else " ".join(args)
    if name != "printf" or not args:
        return None
    layout, *values = args
    if layout in ("%s", r"%s\n"):
        end = "\n" if layout.endswith("n") else ""
        return "".join(v + end for v in values)
    written = layout.replace(r"\n", "\n")
    return None if values or "%" in written or "\\" in written else written


def segment_reads_or_prints(seg: Segment) -> bool:
    """Whether the parsed segment `seg` is a reader or a printer the module docstring lists."""
    return seg.sep in _SEPARATORS and not seg.heredocs and _segment_reads_or_prints(seg.text)


def only_reads_or_prints(command: str) -> bool:
    """Whether every segment of `command` is a reader or a printer the module docstring lists.

    True means no word of the command, quoted or not, reaches anything that runs it.
    """
    p = parse(command)
    if not p.ok or p.substitutions:
        return False
    return all(segment_reads_or_prints(seg) for seg in p.segments)
