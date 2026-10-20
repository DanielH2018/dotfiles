"""Leading `NAME=value` words: which ones the judge reads past, and which stay a prompt.

Typical usage example:

    words = split_assignments("TZ=UTC date")
    if words is not None and words.assignments and prefix_ok(words.assignments):
        judge(words.rest)

Two shapes, two policies, because they reach different processes:

  * A PREFIX (`NAME=v cmd`) puts NAME into `cmd`'s environment. Any program can read any
    variable, and the ones that change what a program executes are an open set (`PATH`,
    `LD_PRELOAD`, `GIT_DIR`, `NODE_OPTIONS`, `GOFLAGS`, `JAVA_TOOL_OPTIONS`, ...). So a
    prefix is read past only when every name is on `PREFIX_NAMES`, an allowlist built from a
    2026-10-20 census of 14 days of transcripts: names that change formatting or a cache
    location and nothing a program runs. `GIT_EDITOR` and its siblings join only with a
    value that is a no-op editor.
  * A STANDALONE segment (`S=/tmp/x`) sets a shell variable for the rest of the chain. It
    reaches a child process only when NAME is already exported, or under `set -a` (the
    judge refuses that option, see judge.py). Exported names are conventionally upper case
    and longer than two characters, so a standalone name is read past only outside that
    convention: one or two characters, or lower case with no underscore. The census found
    `S`, `D`, `U`, `W`, `F` and `SP` behind most of the 63 standalone defers; `VAULT` and
    `http_proxy` stay prompts by the same rule.

Either way the value must be literal: no command substitution, no `${...}` (whose
operators reach arithmetic, which can run a command through an array subscript), and no
unquoted operator that would end the word. A plain `$NAME` reference is allowed; it copies
a value and runs nothing.
"""

import re
from dataclasses import dataclass

from claude_guard.tables import WS

# The census's prefix names that set formatting, locale, time zone or a uv/Homebrew cache
# or switch, and nothing a program executes. `UV_*` reaches only `uv`, and the one `uv`
# form the allow list grants (`uv run`) already runs project code. `PYTHONPATH`, `PATH`,
# `AWS_PROFILE` and the `AIRFLOW__*` names from the same census are left out on purpose.
PREFIX_NAMES: frozenset[str] = frozenset(
    {
        "TZ",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_COLLATE",
        "LC_MESSAGES",
        "LC_TIME",
        "NO_COLOR",
        "FORCE_COLOR",
        "CLICOLOR",
        "CLICOLOR_FORCE",
        "TERM",
        "COLUMNS",
        "LINES",
        "PYTHONDONTWRITEBYTECODE",
        "PYTHONUNBUFFERED",
        "UV_CACHE_DIR",
        "UV_TOOL_DIR",
        "UV_PROJECT_ENVIRONMENT",
        "UV_OFFLINE",
        "UV_NO_SYNC",
        "HOMEBREW_NO_ANALYTICS",
        "HOMEBREW_NO_AUTO_UPDATE",
    }
)

# An editor variable names a command git (or anything else) runs. Only an editor that does
# nothing — `true` or `:` — leaves the command it prefixes doing what it says.
EDITOR_NAMES: frozenset[str] = frozenset({"GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL"})
NOOP_EDITORS: frozenset[str] = frozenset({"true", ":"})

# Two upper-case characters is short enough to fall outside the exported-name convention,
# except for these, which build tools read as the compiler, linker or archiver to run.
_TOOL_NAMES: frozenset[str] = frozenset({"CC", "LD", "AR", "AS", "FC"})

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_STANDALONE_LOWER = re.compile(r"[a-z][a-z0-9]*")
_OPERATORS = frozenset(";&|<>()")


@dataclass(frozen=True, slots=True)
class Assignment:
    """One `NAME=value` word.

    Attributes:
        name: the variable name.
        value: the value with its quotes removed, as the shell assigns it.
    """

    name: str
    value: str


@dataclass(frozen=True, slots=True)
class Assignments:
    """The leading assignment words of one segment and the text after them.

    Attributes:
        assignments: the `NAME=value` words, in order; empty when the segment has none.
        rest: the segment after the last assignment, stripped; empty for a standalone one.
    """

    assignments: tuple[Assignment, ...]
    rest: str


def _read_value(s: str, i: int) -> tuple[str, int] | None:
    """The literal value starting at s[i] and the index after it, or None when it is not
    literal: a substitution, a `${`, a `$` not followed by a name, an unquoted operator,
    a backslash, or an unterminated quote."""
    out = []
    quote = ""
    n = len(s)
    while i < n:
        c = s[i]
        if quote == "'":
            if c == "'":
                quote = ""
            else:
                out.append(c)
            i += 1
            continue
        if c == "`" or c == "\\":
            return None
        if c == "$":
            if not _NAME.match(s, i + 1):
                return None
            out.append(c)
            i += 1
            continue
        if quote == '"':
            if c == '"':
                quote = ""
            else:
                out.append(c)
            i += 1
            continue
        if c in WS:
            break
        if c in _OPERATORS:
            return None
        if c in "'\"":
            quote = c
        else:
            out.append(c)
        i += 1
    if quote:
        return None
    return "".join(out), i


def split_assignments(part: str) -> Assignments | None:
    """Split the leading `NAME=value` words off one segment.

    Returns:
        The assignments and the rest of the segment, with an empty tuple when the first
        word is not an assignment. None when an assignment's value is not literal, which
        the caller must treat as a refusal.
    """
    found: list[Assignment] = []
    i = 0
    n = len(part)
    while True:
        while i < n and part[i] in WS:
            i += 1
        m = _NAME.match(part, i)
        if not m or m.end() >= n or part[m.end()] != "=":
            break
        read = _read_value(part, m.end() + 1)
        if read is None:
            return None
        value, i = read
        found.append(Assignment(m.group(), value))
    return Assignments(tuple(found), part[i:].strip(WS) if found else part)


def standalone_name_ok(name: str) -> bool:
    """True when a standalone assignment to `name` cannot reach a child process's
    environment by the exported-name convention (module docstring)."""
    if len(name) <= 2:
        return name not in _TOOL_NAMES and "_" not in name
    return bool(_STANDALONE_LOWER.fullmatch(name))


def prefix_ok(assignments: tuple[Assignment, ...]) -> bool:
    """True when every prefix assignment is on the allowlist (module docstring)."""
    for a in assignments:
        if a.name in EDITOR_NAMES:
            if a.value not in NOOP_EDITORS:
                return False
        elif a.name not in PREFIX_NAMES:
            return False
    return True
