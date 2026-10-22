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


# merge-base has no option that writes or runs a program.
READ_SUBCOMMANDS: dict[str, Callable[[Sequence[str]], bool]] = {
    "range-diff": _no_output,
    "symbolic-ref": _symbolic_ref,
    "ls-remote": _ls_remote,
    "merge-base": lambda _args: True,
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
