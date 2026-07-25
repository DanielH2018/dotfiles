"""Which adapter owns a command — the one question the wrap hook also asks.

Kept in its own module, importing nothing but the standard library's cheapest
pieces, because the PreToolUse hook calls detect() on the way to every Bash the
agent runs. Loading it through the CLI instead pulled in the XML, JSON and
subprocess machinery of every adapter and cost ~74ms a call; here it costs the
import of `os` and `re`, both of which the hook already pays for.
"""

from __future__ import annotations

import os
import re

# Tokens that stand in front of the real program without being it.
LAUNCHERS = {"uv", "uvx", "poetry", "pdm", "rye", "hatch", "pipenv", "env", "command"}
SUBCOMMANDS = {"run", "exec", "tool", "--"}
PYTHON = re.compile(r"^python(3(\.\d+)?)?$")

# The programs worth asking detect() about at all. The hook checks this first so
# that a Bash call naming none of them costs one set lookup.
CANDIDATES = {
    "node",
    "pytest",
    "prek",
    "ruff",
    "shellcheck",
    "uv",
    "uvx",
    "poetry",
    "pdm",
    "rye",
    "hatch",
    "pipenv",
    "python",
    "python3",
    "find",
    "fd",
    "fdfind",
    "ls",
    "grep",
    "egrep",
    "fgrep",
    "ugrep",
    "rg",
    "git",
}

# git subcommands that only read. Everything else — including every subcommand
# git might grow later — passes through untouched, because a wrapper that
# captures stdout must never be the thing that decides a mutation was safe.
GIT_SURVEYS = {"log": "git-log", "diff": "git-diff", "ls-files": "git-ls-files"}

# git's own options, before the subcommand. The ones listed take a separate
# value, so the token after them is not the subcommand.
GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

# find primaries that either run something or replace the one-path-per-line
# output tq is about to parse. Either way the command is not a path sweep and
# is passed through: -delete and -exec mutate, and the -print variants below
# would leave tq parsing a format it did not ask for.
FIND_UNSAFE = {
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-printf",
    "-print0",
    "-ls",
    "-quit",
}

# Where injecting `-print0` would change which paths find reports rather than
# just how it writes them. `find . -name a -o -name b -print0` binds the -print0
# to the second -name only, so the -name a matches vanish — a silent undercount,
# which is the one failure mode a digest must never have. Seeing any of these,
# tq leaves the command alone and splits the output on newlines instead.
FIND_OPERATORS = {"-o", "-or", "-a", "-and", "!", "-not", "(", ")", ","}

# Flags that make a grep print something other than `file:line:text` — counts,
# bare filenames, or nothing at all. Each is a different shape of answer and
# none of them is the one the matches digest reports.
GREP_OTHER_OUTPUT = {
    "-c",
    "--count",
    "-l",
    "--files-with-matches",
    "-L",
    "--files-without-match",
    "-q",
    "--quiet",
    "--silent",
    "-o",
    "--only-matching",
    "-Z",
    "--null",
}

# ls modes that are not a recursive name listing: the long formats carry
# permissions and sizes per line, which is not a path.
LS_OTHER_OUTPUT = {"l", "g", "o", "n", "i", "s", "m", "x", "C"}


def tool_name(argv):
    """The program a command really runs, seeing through `uv run <tool>` and
    `python -m <tool>`.

    Scanning for the tool's name anywhere in argv is what a first cut does, and
    it misfires on any command that merely mentions it — `grep pytest file` is
    not a test run, and injecting reporter flags into it would be.
    """
    for tok in argv:
        if tok.startswith("-") and tok != "--":
            continue
        base = os.path.basename(tok)
        if base in LAUNCHERS or base in SUBCOMMANDS or PYTHON.match(base):
            continue
        if "=" in base:
            continue  # `env FOO=1 pytest`, and `FOO=1 pytest` via a shell
        return base
    return ""


def git_subcommand(argv):
    """The verb in a git command, past git's own options.

    `git -C /repo log` is a log; `git --version` is not, and neither is a bare
    `git`. Options are skipped by name rather than by counting, because the ones
    that take a value would otherwise hand back their argument as the verb.
    """
    i = argv.index("git") + 1 if "git" in argv else 1
    while i < len(argv):
        tok = argv[i]
        if tok in GIT_VALUE_OPTS:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return tok
    return ""


def ls_is_recursive(argv):
    """`ls -R`, in any of the spellings, and not in a long format.

    Bundled short flags are why this is not a membership test: -lR is a long
    listing and -aR is not, and both look the same to `"-R" in argv`.
    """
    recursive = False
    for tok in argv:
        if tok == "--recursive":
            recursive = True
        elif tok.startswith("--"):
            if tok.lstrip("-").split("=")[0] in ("format", "long"):
                return False
        elif tok.startswith("-") and len(tok) > 1:
            letters = set(tok[1:])
            if letters & LS_OTHER_OUTPUT:
                return False
            recursive = recursive or "R" in letters
    return recursive


def find_is_survey(argv):
    return not any(tok in FIND_UNSAFE for tok in argv)


def fd_is_survey(argv):
    # fd runs commands too, and --list-details is its long format.
    return not any(
        tok in ("-x", "--exec", "-X", "--exec-batch", "-l", "--list-details")
        for tok in argv
    )


def grep_is_survey(argv):
    return not any(tok in GREP_OTHER_OUTPUT for tok in argv)


def detect(argv):
    """Which adapter owns this command, or None to run it untouched."""
    tool = tool_name(argv)
    if tool == "node" and "--test" in argv:
        return "node"
    if tool == "prek":
        return "prek"
    if tool == "pytest":
        return "pytest"
    # `ruff format --check` reports reformatting, not diagnostics, and carries
    # no locations worth digesting — the bare word is what marks a lint run.
    if tool == "ruff" and "check" in argv:
        return "ruff"
    if tool == "shellcheck":
        return "shellcheck"
    if tool == "git":
        sub = git_subcommand(argv)
        # --exit-code and --quiet make the status the answer rather than a
        # report on whether git worked, and a digest that read one as the other
        # would call a diff with changes in it an incomplete enumeration.
        if sub == "diff" and any(t in ("--exit-code", "--quiet") for t in argv):
            return None
        return GIT_SURVEYS.get(sub)
    if tool == "find" and find_is_survey(argv):
        return "find"
    if tool in ("fd", "fdfind") and fd_is_survey(argv):
        return "fd"
    if tool == "ls" and ls_is_recursive(argv):
        return "ls"
    if tool == "rg" and grep_is_survey(argv):
        # `rg --files` takes no pattern and lists what would be searched, which
        # is a path sweep wearing a grep's name. --json rejects it outright.
        return "rg-files" if "--files" in argv else "rg"
    if tool in ("grep", "egrep", "fgrep", "ugrep") and grep_is_survey(argv):
        return "grep"
    return None
