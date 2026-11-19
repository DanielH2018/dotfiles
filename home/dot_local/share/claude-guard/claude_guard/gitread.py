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

import re
from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass

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


# `git config` reads only in one of these modes. Without one, `<key> <value>` writes.
_CONFIG_READ_MODES = frozenset(
    {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "-l", "--list"}
)
# Options that only pick a scope or shape the output. Matched exactly, because git accepts
# any unique abbreviation of a long option and `--ed` is `--edit`, which runs an editor.
# `-f`/`--file` and `--blob` are absent: they read any file, a secret among them.
_CONFIG_READ_FLAGS = frozenset(
    {
        "--global",
        "--system",
        "--local",
        "--worktree",
        "--show-origin",
        "--show-scope",
        "--name-only",
        "--show-names",
        "-z",
        "--null",
        "--includes",
        "--no-includes",
        "--bool",
        "--int",
        "--bool-or-int",
        "--path",
        "--expiry-date",
        "--no-type",
        "--all",
        "--regexp",
        "--fixed-value",
    }
)
_CONFIG_READ_VALUED = ("--type=", "--default=", "--value=", "--url=")


def config_read(args: Sequence[str]) -> bool:
    """True when `git config <args>` only reads.

    A read is the `get` or `list` subcommand, or the legacy form with a `--get…` or
    `--list` mode. Every option must be one this module names, so `--unset`, `--edit`,
    `--file` and an abbreviation of any of them refuse.
    """
    words = [a for a in args if not a.startswith("-")]
    modes = [a for a in args if a in _CONFIG_READ_MODES]
    opts = [a for a in args if a.startswith("-") and a not in _CONFIG_READ_MODES]
    if not all(a in _CONFIG_READ_FLAGS or a.startswith(_CONFIG_READ_VALUED) for a in opts):
        return False
    if words and words[0] in ("get", "list"):
        return not modes
    return bool(modes)


# `git branch NAME` and `git tag NAME` create a ref, and a name after any other listing
# option creates one too. A name is a pattern only once an option below puts the command in
# list mode. Options are matched exactly, so an abbreviation refuses.
_LIST_MODE = frozenset(
    {"-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"}
)
_LIST_SHARED = _LIST_MODE | {
    "-i",
    "--ignore-case",
    "--omit-empty",
    "--color",
    "--no-color",
    "--column",
    "--no-column",
}
_LIST_VALUED = (
    "--sort=",
    "--format=",
    "--color=",
    "--column=",
    "--contains=",
    "--no-contains=",
    "--merged=",
    "--no-merged=",
    "--points-at=",
)


@dataclass(frozen=True)
class _Lister:
    """The listing form of `git branch` or `git tag`.

    Attributes:
        flags: options that only list, matched exactly.
        valued: `--opt=` prefixes of the listing options that take a value.
        short: a short option or cluster that only lists.
        list_mode: the options, besides `_LIST_MODE`, that turn a name into a pattern.
        list_letters: the short letters that do the same.
    """

    flags: frozenset[str]
    valued: tuple[str, ...]
    short: re.Pattern[str]
    list_mode: frozenset[str]
    list_letters: str

    def __call__(self, args: Sequence[str]) -> bool:
        listing = named = False
        for a in args:
            if not a.startswith("-") or a == "-":
                named = True
            elif a in self.flags or a.startswith(self.valued):
                listing |= a.split("=", 1)[0] in _LIST_MODE | self.list_mode
            elif self.short.fullmatch(a):
                listing |= any(c in self.list_letters for c in a)
            else:
                return False
        return listing or not named


# `-a` and `-r` refuse a name outright, and `--show-current` ignores one.
_branch_list = _Lister(
    flags=_LIST_SHARED
    | {"-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "-q", "--quiet"}
    | {"--show-current", "--no-abbrev"},
    valued=(*_LIST_VALUED, "--abbrev="),
    short=re.compile(r"-[arvliq]+"),
    list_mode=frozenset({"--show-current"}),
    list_letters="l",
)
# `-v`/`--verify` runs `gpg.program`, and every option that annotates, signs, forces or
# deletes writes, so none of them is listed. `-n<num>` takes its count stuck to it.
_tag_list = _Lister(
    flags=_LIST_SHARED,
    valued=_LIST_VALUED,
    short=re.compile(r"-[li]*(?:n[0-9]*)?"),
    list_mode=frozenset(),
    list_letters="ln",
)


def _remote(args: Sequence[str]) -> bool:
    # Bare or `-v` lists. `show` without `-n` asks each remote for its refs, as ls-remote
    # does, so a `<transport>::<address>` name refuses as it does there.
    i = 0
    while i < len(args) and args[i] in ("-v", "--verbose"):
        i += 1
    if i == len(args):
        return True
    reads = {"get-url": {"--push", "--all"}, "show": {"-n"}}.get(args[i])
    if reads is None:
        return False
    return all(a in reads or (not a.startswith("-") and "::" not in a) for a in args[i + 1 :])


def _stash(args: Sequence[str]) -> bool:
    # Bare `git stash` pushes. list takes log options and show diff options, so each can
    # write through `--output`.
    return bool(args) and args[0] in ("list", "show") and _no_output(args[1:])


# merge-base has no option that writes or runs a program.
READ_SUBCOMMANDS: dict[str, Callable[[Sequence[str]], bool]] = {
    "range-diff": _no_output,
    "symbolic-ref": _symbolic_ref,
    "ls-remote": _ls_remote,
    "merge-base": lambda _args: True,
    "config": config_read,
    "branch": _branch_list,
    "tag": _tag_list,
    "remote": _remote,
    "stash": _stash,
}


def git_read(argv: Sequence[str], subcommands: Collection[str] = READ_SUBCOMMANDS) -> bool:
    """True when `argv` is a bare `git` running one of `subcommands` in its read form.

    Args:
        argv: the command's words.
        subcommands: the `READ_SUBCOMMANDS` keys to admit; a name outside that table never
            passes.
    """
    if not argv or argv[0] != "git":
        return False
    inv = invocation(list(argv))
    if inv is None or inv.config or inv.shell:
        return False
    if inv.sub not in READ_SUBCOMMANDS or inv.sub not in subcommands:
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
