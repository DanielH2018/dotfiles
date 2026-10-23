"""Read-only git invocations that `remote_guards.GIT_READONLY` cannot list by name alone.

Typical usage example:

    git_read(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])  # True
    git_read(["git", "symbolic-ref", "HEAD", "refs/heads/x"])                 # False: a write

`GIT_READONLY` admits a subcommand with any arguments, so it lists only subcommands no
argument turns into a write. The ones here read with some arguments and write or run a
program with others, so each carries the arguments it admits. Global options are read by
`gitargv.invocation`, and only the ones that change neither config nor where git finds a
program are admitted: `-c`, `--config-env` and `--exec-path` refuse.
"""

from collections.abc import Callable, Sequence

from claude_guard.gitargv import invocation

# Global options that take no value and change neither config nor what git executes.
_SAFE_GLOBAL_FLAGS = frozenset({"--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"})


def _no_output(args: Sequence[str]) -> bool:
    # git accepts any unambiguous abbreviation of a long option, so `--outp=f` is
    # `--output=f`. Refusing every `--o…` also refuses `--output-indicator-*`, which only
    # changes how a diff prints.
    return not any(a.startswith("--o") for a in args)


def _symbolic_ref(args: Sequence[str]) -> bool:
    # Reading takes one name. A second name sets the ref, and `-d`/`--delete` and `-m`
    # belong to the write forms.
    flags = [a for a in args if a.startswith("-")]
    names = [a for a in args if not a.startswith("-")]
    return set(flags) <= {"--short", "-q", "--quiet", "--recurse", "--no-recurse"} and (
        len(names) == 1
    )


_LS_REMOTE_SHORT = frozenset({"-q", "-h", "-t", "-b"})


def _ls_remote(args: Sequence[str]) -> bool:
    # `--upload-pack=<exec>` and its hidden alias `--exec` run a program, and any unique
    # abbreviation of either does too, so every `--u…` and `--e…` refuses except the one
    # `--e…` option that only sets the exit status. A `<transport>::<address>` remote runs
    # a remote helper, `ext::` among them, which runs an arbitrary command.
    for a in args:
        if a.startswith("--"):
            if a.startswith("--u") or (a.startswith("--e") and a != "--exit-code"):
                return False
        elif a.startswith("-"):
            if a not in _LS_REMOTE_SHORT:
                return False
        elif "::" in a:
            return False
    return True


# `git config`'s read actions, as an option and as a verb (git 2.46 and later).
_CONFIG_READ_FLAGS = frozenset(
    {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"}
)
_CONFIG_READ_VERBS = frozenset({"get", "list"})
_CONFIG_WRITE_VERBS = frozenset({"set", "unset", "edit", "rename-section", "remove-section"})
# Options that pick a scope or shape the output. The table is an allowlist, because git
# accepts any unambiguous abbreviation of a long option and `--ed` is `--edit`, which runs
# an editor. `--file` and `--blob` are absent: they read a file this check has not vetted.
_CONFIG_SHAPE_FLAGS = frozenset(
    {
        "--global",
        "--system",
        "--local",
        "--worktree",
        "--show-origin",
        "--show-scope",
        "--name-only",
        "--show-names",
        "--no-show-names",
        "-z",
        "--null",
        "--includes",
        "--no-includes",
        "--bool",
        "--int",
        "--bool-or-int",
        "--path",
        "--expiry-date",
        "--fixed-value",
        "--all",
        "--regexp",
    }
)
_CONFIG_WITH_VALUE = frozenset({"--type", "--default", "--value", "--url"})


def _config(args: Sequence[str]) -> bool:
    # A read names its action, as a flag or as the first word. Without one, git reads a
    # lone name and sets a name followed by a value.
    read_flag = False
    words: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in _CONFIG_READ_FLAGS:
            read_flag = True
        elif a.split("=", 1)[0] in _CONFIG_WITH_VALUE:
            if "=" not in a:
                i += 1
        elif a.startswith("-"):
            if a not in _CONFIG_SHAPE_FLAGS:
                return False
        else:
            words.append(a)
        i += 1
    if words and words[0] in _CONFIG_WRITE_VERBS:
        return False
    return read_flag or (bool(words) and words[0] in _CONFIG_READ_VERBS) or len(words) == 1


# merge-base has no option that writes or runs a program.
READ_SUBCOMMANDS: dict[str, Callable[[Sequence[str]], bool]] = {
    "range-diff": _no_output,
    "symbolic-ref": _symbolic_ref,
    "ls-remote": _ls_remote,
    "merge-base": lambda _args: True,
    "config": _config,
}


def git_read(argv: Sequence[str]) -> bool:
    """True when `argv` is a bare `git` running one of `READ_SUBCOMMANDS` in its read form."""
    if not argv or argv[0] != "git":
        return False
    inv = invocation(list(argv))
    if inv is None or inv.config or inv.shell or inv.sub not in READ_SUBCOMMANDS:
        return False
    opts = list(inv.global_opts)
    i = 0
    while i < len(opts):
        if opts[i] == "-C" and i + 1 < len(opts):
            i += 2
        elif opts[i] in _SAFE_GLOBAL_FLAGS:
            i += 1
        else:
            return False
    return READ_SUBCOMMANDS[inv.sub](inv.args)
