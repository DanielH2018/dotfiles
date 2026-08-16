#!/usr/bin/env python3
"""SessionStart hook: remove Claude session worktrees whose work has already landed.

Every session that isolates its work gets a worktree under `.claude/worktrees/`, and
nothing removed one when its branch merged — Claude Code's exit prompt only covers a
session that is still attached when it ends, not a backgrounded or killed one. Merged
trees therefore pile up next to the live ones and it stops being obvious which is which.

A tree is removable only when all three hold: its branch is an ancestor of the remote's
default branch, it has no uncommitted changes, and no live session holds its lock.

Why those three are enough. Once HEAD is an ancestor of `origin/<default>`, every commit
in the tree is already in the remote by construction — there is nothing recoverable only
from this directory, so no CI or review gate needs re-checking here. If the merged work
later turns out to be wrong it is fixed forward on the default branch, never by
resurrecting the directory. Git-ignored files (a `.venv`, a build dir) do go with the
directory: `git worktree remove` ignores them and so does `git status --porcelain`. They
are regenerable, which is why they were ignored.

The lock is the interesting one. Claude Code locks a session's worktree with a reason
naming the owning process — `claude session <name> (pid 1285937 start 2164388)` — and
does not always release it when the session ends. Treating any lock as "in use" would
keep every abandoned tree forever; `git worktree remove` also refuses outright while a
lock is held, so the dead-owner case is not an edge case, it is the common one. The
`start` field is the process start time from /proc/<pid>/stat, so it tells a live owner
from a dead one whose pid has since been reused, and a lock whose owner is gone is
unlocked and then removed.

Removal never passes `--force`: git's own refusal on a tree containing modified or
untracked files is the last line of defence behind the dirty check.

Merged-ness is judged against the local `origin/<default>` ref as it already stands. The
hook does no network I/O, so a stale ref makes it keep a tree it could have removed —
never the reverse.

Usage:
    prune-worktrees.py            # report only
    prune-worktrees.py --prune    # also remove the removable ones (what the hook runs)

Opt out entirely by setting CLAUDE_WORKTREE_AUTOPRUNE=0 in the environment.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REMOVABLE = "removable"
KEEP = "keep"

LOCK_OWNER = re.compile(r"\(pid (\d+) start (\d+)\)")

LOG_PATH = (
    Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    / "logs"
    / "sessions.log"
)


@dataclass
class Worktree:
    path: str
    head: str
    branch: str | None
    locked: bool
    lock_reason: str = ""


def parse_worktree_list(porcelain: str) -> list[Worktree]:
    """Parse `git worktree list --porcelain` into records, primary checkout first."""
    trees: list[Worktree] = []
    path = head = branch = None
    locked, reason = False, ""
    for line in porcelain.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree ") :]
            head, branch, locked = None, None, False
        elif line.startswith("HEAD "):
            head = line[len("HEAD ") :]
        elif line.startswith("branch "):
            branch = line[len("branch ") :].removeprefix("refs/heads/")
        elif line == "locked" or line.startswith("locked "):
            locked = True
            reason = line[len("locked ") :] if line.startswith("locked ") else ""
        elif line == "" and path is not None:
            trees.append(Worktree(path, head or "", branch, locked, reason))
            path = head = branch = None
            locked, reason = False, ""
    if path is not None:
        trees.append(Worktree(path, head or "", branch, locked, reason))
    return trees


def session_is_alive(lock_reason: str) -> bool:
    """Is the process named in a worktree's lock reason still running?

    The reason Claude Code writes carries the owning pid and its start time, e.g.
    `claude session foo (pid 1285937 start 2164388)`. Comparing the start time against
    /proc/<pid>/stat rejects a pid that has been reused since the session died. A reason
    in any other format is treated as live: an unrecognized lock is someone else's, and
    guessing wrong destroys work.
    """
    match = LOCK_OWNER.search(lock_reason)
    if not match:
        return True
    pid, start = match.group(1), match.group(2)
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    # The comm field can itself contain spaces and parentheses, so field numbering is
    # only reliable after the final ')'. starttime is field 22, the 20th of those after.
    fields = stat.rpartition(")")[2].split()
    return len(fields) > 19 and fields[19] == start


def classify(
    tree: Worktree, merged: bool, dirty: bool, is_current: bool
) -> tuple[str, str]:
    """Return (verdict, reason) for one worktree.

    Reasons are reported in priority order so the output names the blocking condition a
    person would act on first, rather than listing every condition that happens to fail.
    """
    if is_current:
        return KEEP, "this session's own worktree"
    if tree.locked and session_is_alive(tree.lock_reason):
        return KEEP, f"in use — {tree.lock_reason or 'locked'}"
    if dirty:
        return KEEP, "uncommitted changes"
    if tree.branch is None:
        return KEEP, "detached HEAD — no branch to check"
    if not merged:
        return KEEP, f"{tree.branch} not merged"
    return REMOVABLE, f"{tree.branch} merged, clean, unlocked"


def _git(args: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return result.stdout.strip()


def default_ref(repo: str) -> str | None:
    """The remote's default branch ref, or None when there is no merge target at all.

    `origin/HEAD` is what the remote itself says, so it survives a repo whose default is
    neither main nor master. It is only a local symref and can be missing on a clone
    made with --single-branch, hence the two guesses behind it. Returning None keeps
    every tree: without a merge target, nothing can be shown to have landed.
    """
    head = _git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=repo)
    if head:
        return head
    for guess in ("origin/main", "origin/master"):
        if _git(["rev-parse", "--verify", "--quiet", guess], cwd=repo):
            return guess
    return None


def is_merged(repo: str, head: str, target: str) -> bool:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", head, target],
        cwd=repo,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def is_dirty(path: str) -> bool:
    return bool(_git(["status", "--porcelain"], cwd=path))


def log(message: str) -> None:
    """Append one line to the session log — the record of what the hook removed.

    Silent on failure: a hook that cannot write its log still has a job to do, and this
    runs at session start where a traceback would be the first thing on screen.
    """
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with LOG_PATH.open("a") as handle:
            handle.write(f"{stamp} {message}\n")
    except OSError:
        pass


def remove(repo: str, tree: Worktree) -> tuple[bool, str]:
    """Unlock if needed, then remove. Never --force: git's own check is the backstop."""
    if tree.locked:
        subprocess.run(
            ["git", "worktree", "unlock", tree.path],
            cwd=repo,
            capture_output=True,
            check=False,
        )
    result = subprocess.run(
        ["git", "worktree", "remove", tree.path],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0, result.stderr.strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prune merged Claude session worktrees."
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="remove the worktrees reported as removable (default: report only)",
    )
    args = parser.parse_args()

    if os.environ.get("CLAUDE_WORKTREE_AUTOPRUNE") == "0":
        print("worktree autoprune disabled (CLAUDE_WORKTREE_AUTOPRUNE=0)")
        return 0

    # The primary checkout, not this one: worktrees live under the primary's
    # .claude/worktrees/, and --show-toplevel run from inside a worktree returns the
    # worktree itself.
    common_dir = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    if not common_dir:
        # Not a git repo: nothing to do, and nothing worth saying at session start.
        return 0
    repo = str(Path(common_dir).parent)

    trees = parse_worktree_list(_git(["worktree", "list", "--porcelain"], cwd=repo))
    # The first entry is the checkout the others hang off; it is not a session worktree.
    # Only trees under .claude/worktrees/ are ours — one the operator made by hand
    # elsewhere is not this hook's to delete, however merged it looks.
    sessions_dir = Path(repo) / ".claude" / "worktrees"
    sessions = [t for t in trees[1:] if Path(t.path).parent == sessions_dir]
    if not sessions:
        return 0

    target = default_ref(repo)
    here = Path.cwd().resolve()

    removable = []
    for tree in sessions:
        resolved = Path(tree.path).resolve()
        verdict, reason = classify(
            tree,
            merged=bool(target) and is_merged(repo, tree.head, target),
            dirty=is_dirty(tree.path),
            is_current=here == resolved or resolved in here.parents,
        )
        if verdict == REMOVABLE:
            removable.append(tree)
        elif not args.prune:
            print(f"[{KEEP:9}] {tree.path}\n            {reason}")

    if not removable:
        if not args.prune:
            print("nothing to remove")
        return 0

    if not args.prune:
        for tree in removable:
            print(
                f"[{REMOVABLE:9}] {tree.path}\n"
                f"            {tree.branch} merged, clean, unlocked"
            )
        print(f"\n{len(removable)} removable — re-run with --prune to remove")
        return 0

    removed, failed = [], []
    for tree in removable:
        ok, error = remove(repo, tree)
        if ok:
            removed.append(tree)
            log(f"event=worktree_pruned path={tree.path} branch={tree.branch}")
        else:
            failed.append((tree, error))
            log(f"event=worktree_prune_failed path={tree.path} error={error}")

    # Stay silent unless something actually changed on disk — this runs at every session
    # start and a "nothing to do" line every time is noise.
    if removed:
        names = ", ".join(t.branch or t.path for t in removed)
        print(f"Pruned {len(removed)} merged worktree(s): {names}")
    for tree, error in failed:
        print(f"Could not remove {tree.path}: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
