"""Branch-level git that the reflog recovers: `git checkout`/`git switch` to a ref that
exists, `git merge` of refs that exist, and `git rebase` onto refs that exist.

The allow list cannot express any of them as a prefix. `Bash(git checkout:*)` would also
grant `git checkout -- <path>` and `git checkout .`, which overwrite uncommitted edits no
reflog holds, and `Bash(git switch:*)` granted `git switch --discard-changes`. `Bash(git merge
--no-edit:*)` granted `-s ours`, which records a merge while dropping the other side's
changes. In the 7 days to 2026-11-01, 73 prompts were a plain `git merge origin/master` or
`git checkout <branch>` that no rule covered.

Whose checkout it is matters as much as whether the move can be undone. In a repository
several sessions work at once (one with a linked worktree under `.claude/worktrees/`), a
HEAD move in the primary checkout or in another session's worktree changes a branch some
other process is reading. On the homelab server, a primary checkout off `master` parks
`homelab-checkout-sync`, and on 2026-11-09 a fix agent switched its orchestrator's branch.
So every check here first asks `_scope`:

  - `owned`: `cwd` is in a session worktree this caller owns (`worktree_scratch.head_root`).
    A subagent owns only its own isolation worktree, `agent-<agent_id>`.
  - `plain`: the repository has no session worktrees and the caller is not a subagent. The
    checks behave as they did before ownership existed.
  - anything else, a probe failure included: no opinion.

What bounds the commands themselves:

  - Every option comes from a fixed table. A checkout or switch refuses `-f`, `--force`,
    `--discard-changes`, `-m`, `--merge`, `--ours`, `--theirs`, `-p` and `--orphan`. A merge
    refuses every strategy option (`-s`, `-X`), `--no-verify`, `--autostash`, `-F` and an
    editor (`-e`). A rebase refuses `-i`, `--exec`, strategy options, `--root`,
    `--no-verify` and `--autostash`.
  - `-B`/`-C` (create or reset a branch) and `git rebase` pass only in an `owned` worktree.
    Both move a branch tip that the branch's reflog and ORIG_HEAD still hold, and git
    refuses either one on a branch another worktree has checked out.
  - A checkout or switch names at most one ref, and a merge names at least one. Each ref must
    resolve to a commit in `cwd`, or, for a checkout or switch, must name exactly one
    remote-tracking branch, which git's guess turns into a new local branch. A ref that
    resolves nowhere is a pathspec to `git checkout`, so it is refused.
  - A checkout ref that also names a path in `cwd` is refused, because git reads an ambiguous
    word either way. `--` is refused outright: everything after it is a pathspec.
  - `-b`/`-c`/`-B`/`-C` take a new branch name that `git check-ref-format --branch` accepts.

git itself refuses a switch, merge or rebase that would overwrite local changes, and the
previous tip stays in the reflog and in ORIG_HEAD, so none of these loses work.

The probes run git, as git_reset.py's do. A missing or relative `cwd`, a cwd an earlier segment
moved, and any failure of a probe are all no opinion.
"""

import os

from claude_guard.checks.git_reset import _git
from claude_guard.checks.worktree_scratch import head_root, shares_session_worktrees

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
_REBASE_FLAGS = frozenset({"-q", "--quiet", "--stat", "--no-stat", "-n", "--no-autostash"})
# A rebase already under way: each resumes or unwinds it, and `--abort` restores ORIG_HEAD.
_REBASE_CONTROL = frozenset({"--continue", "--abort", "--quit"})


def _scope(cwd: str, cwd_changed: bool, project_dir: str, agent_id: str) -> str | None:
    """`owned`, `plain` or None, as the module docstring defines them."""
    if not cwd or not cwd.startswith("/") or cwd_changed:
        return None
    if head_root(cwd, project_dir, agent_id) is not None:
        return "owned"
    if agent_id or shares_session_worktrees(cwd):
        return None
    return "plain"


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


def checkout_branch_safe(
    argv: list[str], cwd: str, cwd_changed: bool, project_dir: str = "", agent_id: str = ""
) -> bool:
    """True when `argv` is `git checkout` or `git switch` to one existing ref, or creating a
    branch with `-b`/`-c` (or resetting one with `-B`/`-C` in an owned worktree), with only
    options from the table above."""
    if len(argv) < 3 or argv[0] != "git" or argv[1] not in ("checkout", "switch"):
        return False
    scope = _scope(cwd, cwd_changed, project_dir, agent_id)
    if scope is None:
        return False
    switch = argv[1] == "switch"
    flags = _SWITCH_FLAGS if switch else _CHECKOUT_FLAGS
    creates = {"-c", "-C"} if switch else {"-b", "-B"}
    new_branch = None
    refs: list[str] = []
    args = iter(argv[2:])
    for tok in args:
        if tok in flags:
            continue
        if tok in creates:
            if tok.isupper() and scope != "owned":
                return False
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


def merge_safe(
    argv: list[str], cwd: str, cwd_changed: bool, project_dir: str = "", agent_id: str = ""
) -> bool:
    """True when `argv` is `git merge` of one or more refs that resolve to commits, with only
    options from the table above and at most one `-m` message."""
    if len(argv) < 3 or argv[:2] != ["git", "merge"]:
        return False
    if _scope(cwd, cwd_changed, project_dir, agent_id) is None:
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


def rebase_safe(
    argv: list[str], cwd: str, cwd_changed: bool, project_dir: str = "", agent_id: str = ""
) -> bool:
    """True when `argv` is, in an owned worktree, a non-interactive `git rebase [--onto
    <newbase>] <upstream> [<branch>]` of refs that resolve, or one of `--continue`,
    `--abort` and `--quit` alone."""
    if len(argv) < 3 or argv[:2] != ["git", "rebase"]:
        return False
    if _scope(cwd, cwd_changed, project_dir, agent_id) != "owned":
        return False
    if len(argv) == 3 and argv[2] in _REBASE_CONTROL:
        return True
    onto: list[str] = []
    refs: list[str] = []
    args = iter(argv[2:])
    for tok in args:
        if tok in _REBASE_FLAGS:
            continue
        if tok == "--onto":
            newbase = next(args, None)
            if newbase is None:
                return False
            onto.append(newbase)
        elif tok.startswith("--onto="):
            onto.append(tok[len("--onto=") :])
        elif tok.startswith("-"):
            return False
        else:
            refs.append(tok)
    if len(onto) > 1 or not 1 <= len(refs) <= 2:
        return False
    return all(_resolves(cwd, ref) for ref in onto + refs)
