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

Two things the ancestor test does not cover, and how each is handled.

A squash or rebase merge rewrites the commits, so the branch tip is never an ancestor
and the tree would be kept forever with nothing said. `git cherry` catches those: it
compares by patch-id, and a branch every one of whose commits already has an equivalent
on the default branch emits no `+` lines. That is reported, never acted on. Patch-id
equivalence is not provenance — a revert of a revert, a cherry-picked hotfix, or a
whitespace change someone else also made all read as landed — and reaping on it would
invert this script's design, which fails toward keeping the tree. The operator decides.

The same caution runs the other way, and it is easier to miss. A `+` line does not prove
work is unlanded — it only means no commit on the default branch carries that patch-id,
which a reword or a later improvement is enough to cause. Measured 2026-08-21 on
worktree-longhorn-b2-weekly-rearm: `git cherry` reported 16 `+` lines while five of its
eight files were byte-identical to master and the other three were older than master's.
Neither mark is provenance, which is why the report names the command that settles it.

Removing a worktree leaves its branch behind. Nothing else deletes it, so every session
that isolates its work used to leave a permanent ref. A successful removal is now
followed by `git branch -d`, and a second sweep covers session branches that have no
worktree at all. Always `-d`, never `-D`: git's own refusal is the same backstop this
script already relies on for `worktree remove`. That is also why the cherry case is
report-only in both sweeps — `-d` would refuse it anyway. What `-d` accepts is narrower
than "merged" and depends on when you ask; `delete_branch` has the mechanism and why a
refusal does not prove the branch still holds work.

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
# Landed by a squash or rebase merge: reported so it stops being invisible, never
# removed. The module docstring says why patch-id equivalence is not enough to act on.
REVIEW = "review"

# Branches EnterWorktree creates carry this prefix. The orphan sweep uses it to tell a
# session branch from one the operator made by hand, which is not this hook's to delete
# however merged it looks — the same line the worktree sweep draws with
# .claude/worktrees/.
SESSION_BRANCH_PREFIX = "worktree-"

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
    tree: Worktree,
    merged: bool,
    dirty: bool,
    is_current: bool,
    equivalent: bool = False,
) -> tuple[str, str]:
    """Return (verdict, reason) for one worktree.

    Reasons are reported in priority order so the output names the blocking condition a
    person would act on first, rather than listing every condition that happens to fail.

    `equivalent` is the cherry test and is only consulted once `merged` has failed. It
    downgrades "not merged" to REVIEW, which reports and never removes — a tree whose
    work landed by squash still has to be looked at by a person, because patch-id
    equality does not prove this branch is where the work came from.
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
        if equivalent:
            return REVIEW, (
                f"{tree.branch} is not an ancestor of the default branch, but every "
                "commit on it already has an equivalent there — landed by a squash or "
                "rebase merge, OR simply older than what is on the default branch. "
                "Before removing, establish which: `gh pr list --state merged --head "
                f"{tree.branch}` names the merge, and `git diff --stat <default> "
                f"{tree.branch}` shows whether the branch is behind rather than landed."
            )
        return KEEP, f"{tree.branch} not merged"
    return REMOVABLE, f"{tree.branch} merged, clean, unlocked"


def is_equivalent(repo: str, branch: str, target: str) -> bool:
    """Has every commit on `branch` already landed on `target` under a different sha?

    `git cherry` marks a commit `-` when the target already carries a patch-identical
    one and `+` when it does not, so no `+` lines means the whole branch is present.
    Requiring at least one `-` is the guard against reading emptiness as success: a
    branch with no commits of its own also produces no `+`, and calling that "landed"
    would report every freshly-created worktree.
    """
    result = subprocess.run(
        ["git", "cherry", target, branch],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return False
    lines = [ln for ln in result.stdout.splitlines() if ln]
    if not lines or any(ln.startswith("+") for ln in lines):
        return False
    return all(ln.startswith("-") for ln in lines)


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
    """Does this tree hold uncommitted work? Anything short of a clean answer says yes.

    The index is shared across a repo's worktrees, so a `git status` that fails here is
    usually another session mid-write rather than a broken tree. Reading that as "clean"
    would be the one wrong answer that costs work, so anything short of a clean exit —
    including a directory that has vanished from under us — counts as dirty.
    """
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=path,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return True
    return result.returncode != 0 or bool(result.stdout.strip())


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


def delete_branch(repo: str, branch: str) -> bool:
    """Delete a branch with `-d`. Never `-D`.

    `-d` refuses a branch that is not merged into HEAD **or its upstream**, which makes
    git the arbiter rather than this script — the same division of labour `worktree
    remove` gets.

    The upstream half is why a squash-merged branch sometimes deletes cleanly here and
    sometimes does not, which otherwise reads as this script being flaky. `-d` consults
    the local `refs/remotes/origin/<branch>`, and that ref outlives the remote branch: a
    repo with deleteBranchOnMerge has no remote branch from the moment the PR merges,
    but the stale tracking ref still points at the tip until something prunes it. The
    window in which a session branch deletes cleanly therefore closes at the next `git
    fetch --prune`, not at the merge. Measured 2026-08-21: a branch squash-merged
    minutes earlier was accepted, while four older squash-merged ones were refused.

    So a refusal is not proof the branch still holds work. It means git could not
    establish that the work landed, and from here that is indistinguishable from a
    branch where it genuinely has not — keeping it is right in both cases, and neither
    is an error worth reporting. What a refusal does cost is a person: `-D` is then the
    only thing that deletes the branch, and this script will not reach for it. The
    REVIEW verdict exists to put that branch in front of someone.
    """
    result = subprocess.run(
        ["git", "branch", "-d", branch],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def orphan_branches(repo: str, attached: set[str]) -> list[str]:
    """Session branches with no worktree attached, oldest bookkeeping gap in the script.

    Removing a worktree has always left its branch behind, so these accumulate from
    before this sweep existed and from every session that exits any other way. Only
    `worktree-`-prefixed names are considered; `-d` then decides which of those go.
    """
    out = _git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], cwd=repo)
    return [
        b
        for b in out.splitlines()
        if b.startswith(SESSION_BRANCH_PREFIX) and b not in attached
    ]


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

    target = default_ref(repo)
    here = Path.cwd().resolve()

    removable, review = [], []
    for tree in sessions:
        resolved = Path(tree.path).resolve()
        merged = bool(target) and is_merged(repo, tree.head, target)
        # The cherry test costs a patch-id walk per branch, so it only runs once the
        # cheap ancestor test has already failed — which is the only case it can change.
        equivalent = (
            not merged
            and bool(target)
            and tree.branch is not None
            and is_equivalent(repo, tree.branch, target)
        )
        verdict, reason = classify(
            tree,
            merged=merged,
            dirty=is_dirty(tree.path),
            is_current=here == resolved or resolved in here.parents,
            equivalent=equivalent,
        )
        if verdict == REMOVABLE:
            removable.append(tree)
        elif verdict == REVIEW:
            review.append((tree, reason))
        elif not args.prune:
            print(f"[{KEEP:9}] {tree.path}\n            {reason}")

    # Branches whose worktree is already gone. Every attached branch is excluded, not
    # just this repo's session ones, so a branch checked out anywhere is never a
    # candidate — `git branch -d` refuses that too, but not reaching for it is clearer.
    attached = {t.branch for t in trees if t.branch}
    orphans = orphan_branches(repo, attached)
    orphan_merged = [b for b in orphans if bool(target) and is_merged(repo, b, target)]
    orphan_review = [
        b
        for b in orphans
        if b not in orphan_merged and bool(target) and is_equivalent(repo, b, target)
    ]

    if not args.prune:
        for tree in removable:
            print(
                f"[{REMOVABLE:9}] {tree.path}\n"
                f"            {tree.branch} merged, clean, unlocked"
            )
        for tree, reason in review:
            print(f"[{REVIEW:9}] {tree.path}\n            {reason}")
        for branch in orphan_merged:
            print(f"[{REMOVABLE:9}] branch {branch}\n            merged, no worktree")
        for branch in orphan_review:
            print(
                f"[{REVIEW:9}] branch {branch}\n"
                "            no worktree, and every commit has an equivalent on the "
                "default branch — landed by a squash or rebase merge, or just older "
                "than it. Check `gh pr list --state merged --head <branch>` before "
                "deleting."
            )
        total = len(removable) + len(orphan_merged)
        if total:
            print(f"\n{total} removable — re-run with --prune to remove")
        elif not review and not orphan_review:
            print("nothing to remove")
        return 0

    removed, failed, branches = [], [], []
    for tree in removable:
        ok, error = remove(repo, tree)
        if ok:
            removed.append(tree)
            log(f"event=worktree_pruned path={tree.path} branch={tree.branch}")
            # Only after the worktree is gone: git refuses to delete a checked-out
            # branch, so the order is a precondition rather than a preference.
            if tree.branch and delete_branch(repo, tree.branch):
                branches.append(tree.branch)
                log(f"event=branch_deleted branch={tree.branch}")
        else:
            failed.append((tree, error))
            log(f"event=worktree_prune_failed path={tree.path} error={error}")

    for branch in orphan_merged:
        if delete_branch(repo, branch):
            branches.append(branch)
            log(f"event=orphan_branch_deleted branch={branch}")

    # Stay silent unless something actually changed on disk — this runs at every session
    # start and a "nothing to do" line every time is noise. The review cases are the
    # exception: they are silent by nature, which is the bug they exist to fix.
    if removed:
        names = ", ".join(t.branch or t.path for t in removed)
        print(f"Pruned {len(removed)} merged worktree(s): {names}")
    if branches:
        print(f"Deleted {len(branches)} merged branch(es): {', '.join(branches)}")
    for tree, reason in review:
        print(f"Kept {tree.path}: {reason}")
    for branch in orphan_review:
        print(
            f"Branch {branch} has no worktree and every commit on it has an "
            "equivalent on the default branch — landed by a squash or rebase merge, or "
            "merely older than it. Establish which before deleting: `gh pr list "
            f"--state merged --head {branch}`."
        )
    for tree, error in failed:
        print(f"Could not remove {tree.path}: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
