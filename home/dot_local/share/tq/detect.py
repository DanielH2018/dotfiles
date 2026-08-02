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
    "mypy",
    "eslint",
    "tsc",
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
    "go",
    "cargo",
    "gradle",
    "gradlew",
    "mvn",
    "journalctl",
    "coredumpctl",
}

# git subcommands that only read. Everything else — including every subcommand
# git might grow later — passes through untouched, because a wrapper that
# captures stdout must never be the thing that decides a mutation was safe.
GIT_SURVEYS = {"log": "git-log", "diff": "git-diff", "ls-files": "git-ls-files"}

# git's own options, before the subcommand. The ones listed take a separate
# value, so the token after them is not the subcommand.
GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

# go's own options, before the subcommand. Far rarer than git's — -C (change
# directory before running, added in Go 1.20) is the one that takes a
# separate value.
GO_VALUE_OPTS = {"-C"}

# go subcommands this owns. Everything else — build, run, get, mod, etc. —
# passes through untouched, on the same principle as git's log/diff/ls-files
# carve-out: a wrapper that captures stdout must never decide a build was safe
# to claim.
GO_SUBCOMMANDS = {"test": "go-test", "vet": "go-vet"}

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
#
# Short and long are kept apart because a short one can arrive bundled. `-rl`
# is a file list and `-rn` is not, and to a membership test on whole tokens
# they look equally unlike `-l`; the letters have to be looked at one at a time.
GREP_OTHER_LETTERS = set("clLqoZ")
GREP_OTHER_LONG = {
    "--count",
    "--files-with-matches",
    "--files-without-match",
    "--quiet",
    "--silent",
    "--only-matching",
    "--null",
}

# Short options whose value may be attached in the same token. Expanding a
# bundle has to stop at one of these, because what follows it is the value and
# not more flags: the `o` in `-eTODO` is part of the pattern.
GREP_VALUE_LETTERS = set("efmABCDd")

# The same two questions for ripgrep, which shares grep's letters for the
# output modes but not for the options that take a value — `-r` is
# --recursive to grep and --replace to rg, and reading it as the wrong one
# either drops the rest of a bundle or keeps reading a replacement string.
RG_OTHER_LETTERS = set("clqo0")
RG_VALUE_LETTERS = set("efmABCgtTMr")

# fd runs commands too, and --list-details is its long format.
FD_OTHER_LETTERS = set("xXl")
FD_OTHER_LONG = {"--exec", "--exec-batch", "--list-details"}
FD_VALUE_LETTERS = set("detESj")

# ls modes that are not a recursive name listing: the long formats carry
# permissions and sizes per line, which is not a path.
LS_OTHER_OUTPUT = {"l", "g", "o", "n", "i", "s", "m", "x", "C"}

# journalctl flags that narrow the journal to something bounded. tq buffers the
# whole of what it wraps — process.run captures rather than streams — and the
# journal is unbounded by default, so a bare `journalctl` under tq reads the
# entire archive into memory as JSON, several times the size of the text the
# bare command would have paged. Declining is the same answer FIND_UNSAFE gives:
# where wrapping is worse than not wrapping, tq does not claim the command.
JOURNAL_BOUNDS = {
    "-n",
    "--lines",
    "-S",
    "--since",
    "-U",
    "--until",
    "-u",
    "--unit",
    "--user-unit",
    "-b",
    "--boot",
    "-p",
    "--priority",
    "-k",
    "--dmesg",
    "-t",
    "--identifier",
    "-g",
    "--grep",
    "-e",
    "--pager-end",
}

# journalctl modes that mutate the journal, never terminate, or answer a
# different question than "which records". --vacuum-* and --rotate delete;
# --follow never returns, and tq builds its digest only once the process exits,
# so wrapping one would hang where the bare command streams.
JOURNAL_UNSAFE = {
    "-f",
    "--follow",
    "--rotate",
    "--flush",
    "--sync",
    "--relinquish-var",
    "--smart-relinquish-var",
    "--setup-keys",
    "--verify",
    "--header",
    "--disk-usage",
    "--list-boots",
    "--list-catalog",
    "--dump-catalog",
    "--update-catalog",
    "--new-id128",
    "--version",
    "-h",
    "--help",
}

# Prefix forms of the above, for the flags that carry their value attached.
JOURNAL_UNSAFE_PREFIXES = ("--vacuum-",)

# The output format is tq's to choose, the same way --json is for rg. A command
# that already names one is asking for a shape tq would overwrite, so it is left
# to say what it was asked to say.
JOURNAL_FORMAT = ("-o", "--output")

# coredumpctl verbs. `list` is the only one that enumerates; `info` prints a
# report per core, `dump` writes the core out and `debug` launches a debugger —
# the last two mutate or go interactive, which no wrapper capturing stdout may
# claim.
COREDUMP_SURVEYS = {"list": "coredumpctl"}

# coredumpctl options that take a separate value, so the token after them is not
# the verb.
COREDUMP_VALUE_OPTS = {
    "-o",
    "--output",
    "-n",
    "-S",
    "--since",
    "-U",
    "--until",
    "-D",
    "--directory",
    "-F",
    "--field",
    "--file",
    "--debugger",
    "--root",
    "--image",
}

# `-o`/`--output` writes the core to a file, which is a mutation wearing an
# output flag's name. --field prints one field per line and --json picks the
# shape tq is about to pick, both of which are a different answer than the
# listing this digests.
COREDUMP_UNSAFE = {"-o", "--output", "-F", "--field"}
COREDUMP_UNSAFE_PREFIXES = ("--json", "--field=", "--output=")


def _has(argv, names, prefixes=()):
    """Whether argv carries any of these flags, attached value or not."""
    for tok in argv:
        if tok == "--":
            break  # past the separator a token is an operand, not a flag
        if tok in names:
            return True
        if any(tok.startswith(f"{name}=") for name in names):
            return True
        if prefixes and tok.startswith(prefixes):
            return True
        # A short flag may carry its value in the same token: `-n50`, `-u ssh`.
        if any(
            len(name) == 2 and name.startswith("-") and tok.startswith(name)
            for name in names
        ):
            return True
    return False


def journalctl_is_survey(argv):
    """A bounded, read-only journal query — anything else passes through."""
    if _has(argv, JOURNAL_UNSAFE, JOURNAL_UNSAFE_PREFIXES):
        return False
    if _has(argv, JOURNAL_FORMAT):
        return False
    return _has(argv, JOURNAL_BOUNDS)


def coredumpctl_subcommand(argv):
    """The verb in a coredumpctl command, past its own options.

    A bare `coredumpctl` lists, so an absent verb is "list" rather than nothing —
    which is the opposite of git, where a bare `git` is not a survey of anything.
    """
    i = 1
    while i < len(argv):
        tok = argv[i]
        if tok in COREDUMP_VALUE_OPTS:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return argv[i]
    return "list"


def coredumpctl_is_survey(argv):
    if _has(argv, COREDUMP_UNSAFE, COREDUMP_UNSAFE_PREFIXES):
        return False
    return coredumpctl_subcommand(argv) in COREDUMP_SURVEYS


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


def git_subcommand_index(argv):
    """Where the verb sits in a git command, past git's own options, or -1.

    `git -C /repo log` is a log; `git --version` is not, and neither is a bare
    `git`. Options are skipped by name rather than by counting, because the ones
    that take a value would otherwise hand back their argument as the verb.

    The position rather than the token, because the runners need somewhere to
    splice their format flags in — after the verb, since a flag ahead of it is
    git's own and `git --numstat log` is an error. A second copy of this walk
    living in the runners would be one more thing to keep in step.
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
        return i
    return -1


def git_subcommand(argv):
    i = git_subcommand_index(argv)
    return argv[i] if i >= 0 else ""


def go_subcommand_index(argv):
    """Where the verb sits in a go command, past go's own options, or -1.

    Mirrors git_subcommand_index for the same reason: `go -C dir test` must
    not read "-C" as the verb, and the position is what run_go_test needs to
    splice -json in after, not just the token.
    """
    i = argv.index("go") + 1 if "go" in argv else 1
    while i < len(argv):
        tok = argv[i]
        if tok in GO_VALUE_OPTS:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return i
    return -1


def go_subcommand(argv):
    i = go_subcommand_index(argv)
    return argv[i] if i >= 0 else ""


# cargo subcommands tq digests. Everything else — build, run, publish, add,
# and every subcommand cargo might grow later — passes through untouched, the
# same principle as git's GIT_SURVEYS: a wrapper that captures stdout must
# never be the thing that decides a subcommand was safe to reinterpret.
CARGO_SUBCOMMANDS = {"clippy": "cargo-clippy", "test": "cargo-test"}

# cargo's own global options, before the subcommand, that take a separate
# value — the token after one of these is not the subcommand.
CARGO_VALUE_OPTS = {"--config", "--manifest-path", "--target-dir", "-C"}


def cargo_subcommand_index(argv):
    """Where the verb sits in a cargo command, past cargo's own options, or -1.

    Same shape as git_subcommand_index: options are skipped by name, not by
    counting, because a value-taking one would otherwise hand back its
    argument as the verb.
    """
    i = argv.index("cargo") + 1 if "cargo" in argv else 1
    while i < len(argv):
        tok = argv[i]
        if tok in CARGO_VALUE_OPTS:
            i += 2
            continue
        if tok.startswith("-"):
            i += 1
            continue
        return i
    return -1


def cargo_subcommand(argv):
    i = cargo_subcommand_index(argv)
    return argv[i] if i >= 0 else ""


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


def short_letters(tok, value_letters):
    """The flag letters in a bundled short option like `-rln`, or ().

    Expansion stops at the first letter that takes a value, because the rest of
    the token is that value rather than more flags.
    """
    if not tok.startswith("-") or tok.startswith("--") or len(tok) < 2:
        return ()
    out = []
    for char in tok[1:]:
        out.append(char)
        if char in value_letters:
            break
    return tuple(out)


def _no_other_output(argv, letters, long_forms, value_letters):
    """Whether every flag in argv leaves the output in the shape tq parses.

    Scanning stops at `--`, past which a token is the pattern or a path: in
    `grep -- -l file` the -l is what is being searched for.
    """
    for tok in argv:
        if tok == "--":
            break
        if tok.split("=")[0] in long_forms:
            return False
        if set(short_letters(tok, value_letters)) & letters:
            return False
    return True


def find_is_survey(argv):
    return not any(tok in FIND_UNSAFE for tok in argv)


def fd_is_survey(argv):
    return _no_other_output(argv, FD_OTHER_LETTERS, FD_OTHER_LONG, FD_VALUE_LETTERS)


def rg_is_survey(argv):
    return _no_other_output(argv, RG_OTHER_LETTERS, GREP_OTHER_LONG, RG_VALUE_LETTERS)


def grep_is_survey(argv):
    return _no_other_output(
        argv, GREP_OTHER_LETTERS, GREP_OTHER_LONG, GREP_VALUE_LETTERS
    )


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
    # --install-types prompts and mutates the environment rather than checking
    # it, and neither flag below reports diagnostics for --output=json to carry.
    if tool == "mypy" and not any(
        t in ("--version", "-h", "--help", "--install-types") for t in argv
    ):
        return "mypy"
    # --print-config answers with a config object, not diagnostics, and both
    # flags below print to stdout and exit before any file is linted.
    if tool == "eslint" and not any(
        t in ("--version", "-h", "--help", "--print-config", "--init") for t in argv
    ):
        return "eslint"
    # --showConfig answers with the resolved tsconfig, not diagnostics, and
    # --init writes a new one instead of checking anything.
    if tool == "tsc" and not any(
        t in ("--version", "-h", "--help", "--init", "--showConfig") for t in argv
    ):
        return "tsc"
    if tool == "shellcheck":
        return "shellcheck"
    if tool == "go":
        return GO_SUBCOMMANDS.get(go_subcommand(argv))
    if tool == "cargo":
        return CARGO_SUBCOMMANDS.get(cargo_subcommand(argv))
    # `gradle build`/`mvn install` also run tests as a side effect of their
    # default lifecycle, but claiming that requires understanding Gradle's and
    # Maven's lifecycle bindings — out of scope. Only a bare "test" token is
    # unambiguous, the same exact-membership care FIND_UNSAFE and the grep
    # letter sets take elsewhere: "testCompile" must not match.
    if tool in ("gradle", "gradlew") and "test" in argv:
        return "gradle-test"
    if tool == "mvn" and "test" in argv:
        return "mvn-test"
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
    if tool == "rg" and rg_is_survey(argv):
        # `rg --files` takes no pattern and lists what would be searched, which
        # is a path sweep wearing a grep's name. --json rejects it outright.
        return "rg-files" if "--files" in argv else "rg"
    if tool in ("grep", "egrep", "fgrep", "ugrep") and grep_is_survey(argv):
        return "grep"
    if tool == "journalctl" and journalctl_is_survey(argv):
        return "journalctl"
    if tool == "coredumpctl" and coredumpctl_is_survey(argv):
        return "coredumpctl"
    return None
