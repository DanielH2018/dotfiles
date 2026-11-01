"""Branch-level git that the reflog recovers: `git checkout`/`git switch` to a ref that
exists, and `git merge` of refs that exist.

The allow list cannot express either as a prefix. `Bash(git checkout:*)` would also grant
`git checkout -- <path>` and `git checkout .`, which overwrite uncommitted edits no reflog
holds, and `Bash(git switch:*)` granted `git switch --discard-changes`. `Bash(git merge
--no-edit:*)` granted `-s ours`, which records a merge while dropping the other side's
changes. In the 7 days to 2026-11-01, 73 prompts were a plain `git merge origin/master` or
`git checkout <branch>` that no rule covered.

What bounds them:

  - Every option comes from a fixed table. A checkout or switch refuses `-f`, `--force`,
    `--discard-changes`, `-m`, `--merge`, `--ours`, `--theirs`, `-p`, `--orphan` and `-B`/`-C`,
    and a merge refuses every strategy option (`-s`, `-X`), `--no-verify`, `--autostash`, `-F`
    and an editor (`-e`).
  - A checkout or switch names at most one ref, and a merge names at least one. Each ref must
    resolve to a commit in `cwd`, or, for a checkout or switch, must name exactly one
    remote-tracking branch, which git's guess turns into a new local branch. A ref that
    resolves nowhere is a pathspec to `git checkout`, so it is refused.
  - A checkout ref that also names a path in `cwd` is refused, because git reads an ambiguous
    word either way. `--` is refused outright: everything after it is a pathspec.
  - `-b`/`-c` take a new branch name that `git check-ref-format --branch` accepts.

git itself refuses a switch or a merge that would overwrite local changes, and the previous
tip stays in the reflog and in ORIG_HEAD, so none of these loses work.

The probes run git, as git_reset.py's do. A missing or relative `cwd`, a cwd an earlier segment
moved, and any failure of a probe are all no opinion.
"""

import os

from claude_guard.checks.git_reset import _git

_SWITCH_FLAGS = frozenset({"-q", "--quiet", "--detach", "-d", "--guess", "--no-guess"})
_CHECKOUT_FLAGS = frozenset({"-q", "--quiet", "--detach", "--guess", "--no-guess"})
_MERGE_FLAGS = frozenset(
    {
        "-q",
        "--quiet",
        "--no-edit",
        "--ff",
        "--no-ff",
        "--ff-only",
        "--commit",
        "--no-commit",
        "--squash",
        "--no-squash",
        "--stat",
        "--no-stat",
        "-n",
        "--log",
        "--no-log",
        "--signoff",
        "--no-signoff",
        "--progress",
        "--no-progress",
    }
)


def _resolves(cwd: str, ref: str) -> bool:
    """True when `ref` names a commit in the repository at `cwd`."""
    return (
        _git(cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}")
        is not None
    )


def _one_remote_branch(cwd: str, name: str) -> bool:
    """True when exactly one remote-tracking branch is called `name`, which git's checkout
    guess turns into a local branch tracking it."""
    out = _git(cwd, "for-each-ref", "--format=%(refname)", f"refs/remotes/*/{name}")
    return out is not None and len(out.split()) == 1


def checkout_branch_safe(argv: list[str], cwd: str, cwd_changed: bool) -> bool:
    """True when `argv` is `git checkout` or `git switch` to one existing ref, or creating a
    branch with `-b`/`-c`, with only options from the table above."""
    if len(argv) < 3 or argv[0] != "git" or argv[1] not in ("checkout", "switch"):
        return False
    if not cwd or not cwd.startswith("/") or cwd_changed:
        return False
    switch = argv[1] == "switch"
    flags = _SWITCH_FLAGS if switch else _CHECKOUT_FLAGS
    create = "-c" if switch else "-b"
    new_branch = None
    refs: list[str] = []
    args = iter(argv[2:])
    for tok in args:
        if tok in flags:
            continue
        if tok == create:
            new_branch = next(args, None)
            if new_branch is None or _git(cwd, "check-ref-format", "--branch", new_branch) is None:
                return False
        elif tok == "-":
            refs.append(tok)
        elif tok.startswith("-"):
            return False
        else:
            refs.append(tok)
    if len(refs) > 1 or (not refs and new_branch is None):
        return False
    for ref in refs:
        if ref == "-":
            continue
        if not switch and os.path.lexists(os.path.join(cwd, ref)):
            return False
        if not _resolves(cwd, ref) and (new_branch is not None or not _one_remote_branch(cwd, ref)):
            return False
    return True


def merge_safe(argv: list[str], cwd: str, cwd_changed: bool) -> bool:
    """True when `argv` is `git merge` of one or more refs that resolve to commits, with only
    options from the table above and at most one `-m` message."""
    if len(argv) < 3 or argv[:2] != ["git", "merge"]:
        return False
    if not cwd or not cwd.startswith("/") or cwd_changed:
        return False
    refs: list[str] = []
    args = iter(argv[2:])
    for tok in args:
        if tok in _MERGE_FLAGS:
            continue
        if tok in ("-m", "--message"):
            if next(args, None) is None:
                return False
        elif tok.startswith("--message=") or (tok.startswith("-m") and len(tok) > 2):
            continue
        elif tok.startswith("-"):
            return False
        else:
            refs.append(tok)
    return bool(refs) and all(_resolves(cwd, ref) for ref in refs)
