#!/usr/bin/env python3
# gen-hooks: register
#   event: SessionStart
#   matcher: startup|resume|clear
#   timeout: 15
#   order: 50
#   args: --prune
# The startup slot prune-artifacts.sh sweeps in, for session worktrees: remove the
# ones under
# .claude/worktrees/ whose branch is already an ancestor of origin/HEAD, are clean,
# and hold no live session's lock. Claude Code's exit prompt only reaches a session
# still attached when it ends, so a backgrounded or killed one leaves its tree
# behind forever. Every source that opens a working session, not just "startup":
# a resumed session is the long-lived case where merged siblings pile up, and its
# own tree is protected by the is_current check either way. Not "compact", which
# fires mid-turn and would sweep for nothing. CLAUDE_WORKTREE_AUTOPRUNE=0 opts
# out; every removal is logged to ~/.claude/logs/sessions.log.
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

"Merged" is judged three ways, cheapest first, and only the first one acts.

Ancestry is the one that removes. Once HEAD is an ancestor of the default branch the
argument above holds and the tree goes. The other two exist because a squash or rebase
merge rewrites the commits, so the branch tip is never an ancestor and the tree would
be kept forever with nothing said. Both are reported, never acted on.

`git cherry` catches the rebase case: it compares by patch-id, and a branch every one
of whose commits already has an equivalent on the default branch emits no `+` lines.
Patch-id equivalence is not provenance — a revert of a revert, a cherry-picked hotfix,
or a whitespace change someone else also made all read as landed — and reaping on it
would invert this script's design, which fails toward keeping the tree.

The same caution runs the other way, and it is easier to miss. A `+` line does not prove
work is unlanded — it only means no commit on the default branch carries that patch-id,
which a reword or a later improvement is enough to cause. Measured 2026-08-21 on
worktree-longhorn-b2-weekly-rearm: `git cherry` reported 16 `+` lines while five of its
eight files were byte-identical to master and the other three were older than master's.
Neither mark is provenance, which is why the report names the command that settles it.

`git merge-tree` catches the squash case, which patch-id cannot: several commits
collapse into one, so no commit on the default branch matches any of theirs. It asks
about content instead of history — merge the branch into the default branch, and if the
resulting tree IS the default branch's tree, the branch has nothing left to give. That
is exactly what a squash merge leaves behind. It is also what a branch superseded by
later work looks like, and a conflict (the default branch drifted on a file the branch
touched) yields no verdict at all, which reads as not landed. Content equality is even
less provenance than patch-id, so it is the last signal consulted and the one furthest
from acting. The operator decides.

Removing a worktree leaves its branch behind. Nothing else deletes it, so every session
that isolates its work used to leave a permanent ref. A successful removal is now
followed by `git branch -d`, and a second sweep covers session branches that have no
worktree at all. Always `-d`, never `-D`: git's own refusal is the same backstop this
script already relies on for `worktree remove`. That is also why the cherry and
merge-tree cases are report-only in both sweeps — `-d` would refuse them anyway. What
`-d` accepts is narrower than "merged" and depends on when you ask; `delete_branch` has
the mechanism and why a refusal does not prove the branch still holds work.

The orphan branches the cherry and merge-tree tests flag are counted, not listed. They
accumulate: `-d` refuses every one of them, so nothing ever clears them. Listing each
with its reason printed 51,010 bytes at a server-repo session start on 2026-09-24: 172
near-identical paragraphs, too large for the harness to inject. One line now carries
the count and names `--orphans`, which lists them.

A repo that ships its own pruner at `scripts/dev/prune_worktrees.py` is skipped. That
pruner asks the forge which head SHA a PR merged, and this hook does not. The two used
to give opposite verdicts on the same tree. The repo's own session banner is then the
one reporter.

Usage:
    prune-worktrees.py              # report only
    prune-worktrees.py --prune      # also remove the removable ones (the hook's mode)
    prune-worktrees.py --orphans    # also list each landed-looking orphan branch

Opt out entirely by setting CLAUDE_WORKTREE_AUTOPRUNE=0 in the environment.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# The readers this hook shares with the server repo's pruner — the porcelain parser, the
# lock-liveness check, the cherry and merge-tree verdicts, the default-ref lookup — live
# in the claude-worktree package (`home/dot_local/share/claude-worktree/`), deployed
# beside claude-guard. There is no fallback copy here: a hook that cannot import its
# readers keeps every tree, which is the direction this script fails in anyway. The
# standalone test points CLAUDE_WORKTREE_HOME at the source tree; a session has the
# deployed path.
_CLAUDE_WORKTREE_HOME = Path(
    os.environ.get("CLAUDE_WORKTREE_HOME", Path.home() / ".local/share/claude-worktree")
)
if _CLAUDE_WORKTREE_HOME.is_dir():
    sys.path.insert(0, str(_CLAUDE_WORKTREE_HOME))
try:
    from claude_worktree import (
        Worktree,
        cherry_says_landed,
        default_ref,
        merge_tree_says_contained,
        parse_worktree_list,
        session_is_alive,
    )
except ImportError as exc:
    # Imported by its test: fail loudly. Run as the hook: say why nothing was pruned and
    # let the session start — a SessionStart hook must never block a session.
    if __name__ != "__main__":
        raise
    print(
        f"worktree autoprune skipped: {exc} — `chezmoi apply` deploys "
        f"{_CLAUDE_WORKTREE_HOME}"
    )
    sys.exit(0)

REMOVABLE = "removable"
KEEP = "keep"
# Landed by a squash or rebase merge: reported so it stops being invisible, never
# removed. The module docstring says why neither patch-id equivalence nor content
# equality is enough to act on.
REVIEW = "review"

# Branches EnterWorktree creates carry this prefix. The orphan sweep uses it to tell a
# session branch from one the operator made by hand, which is not this hook's to delete
# however merged it looks — the same line the worktree sweep draws with
# .claude/worktrees/.
SESSION_BRANCH_PREFIX = "worktree-"

# A repo carrying this file prunes its own worktrees, and this hook stands aside for it.
# The server repo's pruner is the one it names: it adds the forge check this hook lacks.
OWN_PRUNER = Path("scripts") / "dev" / "prune_worktrees.py"

LOG_PATH = (
    Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    / "logs"
    / "sessions.log"
)


def classify(
    tree: Worktree,
    merged: bool,
    dirty: bool,
    is_current: bool,
    equivalent: bool = False,
    contained: bool = False,
) -> tuple[str, str]:
    """Return (verdict, reason) for one worktree.

    Reasons are reported in priority order so the output names the blocking condition a
    person would act on first, rather than listing every condition that happens to fail.

    `equivalent` is the cherry test and `contained` the merge-tree test; both are only
    consulted once `merged` has failed. Either downgrades "not merged" to REVIEW, which
    reports and never removes — a tree whose work landed by squash still has to be
    looked at by a person, because neither patch-id equality nor content equality
    proves this branch is where the work came from. The two get distinct reasons
    because they are settled differently: a patch-id match can be a branch that is
    merely older than the default branch, a content match can be one later work
    superseded.
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
        if contained:
            return REVIEW, (
                f"{tree.branch} is not an ancestor of the default branch and no commit "
                "on it has a patch-id match there, but merging it would change nothing "
                "— its content is already on the default branch. That is what a squash "
                "merge leaves behind, OR a branch that later work superseded. Before "
                "removing, establish which: `gh pr list --state merged --head "
                f"{tree.branch}` names the merge, and `git log --oneline <default>.."
                f"{tree.branch}` lists the commits whose content would be lost."
            )
        return KEEP, f"{tree.branch} not merged"
    return REMOVABLE, f"{tree.branch} merged, clean, unlocked"


def is_equivalent(repo: str, branch: str, target: str) -> bool:
    """Has every commit on `branch` already landed on `target` under a different sha?

    `git cherry` marks a commit `-` when the target already carries a patch-identical
    one and `+` when it does not, so no `+` lines means the whole branch is present.
    `empty_means=False` is the guard against reading emptiness as success: a branch
    with no commits of its own also produces no `+`, and calling that "landed" would
    report every freshly-created worktree. (The server pruner passes True there, because
    it gates on the exit status first and then removes; this hook only reports.)
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
    return cherry_says_landed(result.stdout, empty_means=False)


def is_contained(repo: str, branch: str, target: str) -> bool:
    """Would merging `branch` into `target` change nothing? Content, not history.

    Only meaningful once the ancestor test has failed: a branch that IS an ancestor is
    trivially contained, so on its own this would flag every fresh worktree. Ordered
    last because it performs a real (in-memory) merge, where the other two signals
    only walk history.

    Every failure reads as "not contained": a conflict, where the target drifted on a
    file the branch also touched, exits non-zero and is a genuine no-verdict — and so is
    a git older than 2.38, which lacks `--write-tree`. The REVIEW verdict this feeds is
    report-only, so a false negative here costs a line of output and a false positive
    costs a person's attention; neither costs work.
    """
    target_tree = _git(["rev-parse", f"{target}^{{tree}}"], cwd=repo)
    result = subprocess.run(
        ["git", "merge-tree", "--write-tree", target, branch],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return False
    return merge_tree_says_contained(result.stdout, target_tree)


def _git(args: list[str], cwd: str | None = None) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
    )
    return result.stdout.strip()


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


def report_orphans(branches: list[str], itemise: bool) -> None:
    """Print the landed-looking orphan branches: one row each, or one line in all.

    The count is the default because these never clear on their own. `-d` refuses each
    one, so the list only grows, and a row per branch at every session start is what
    this line replaced. The reason is the same for every branch, so it prints once.
    """
    if not branches:
        return
    if not itemise:
        command = str(Path(__file__)).replace(str(Path.home()), "~", 1)
        print(
            f"{len(branches)} landed-looking branch(es) with no worktree; "
            f"run `{command} --orphans` to list them"
        )
        return
    print(
        f"{len(branches)} branch(es) with no worktree, and nothing on them is missing "
        "from the default branch (by patch-id or by content). Each landed by a squash "
        "or rebase merge, or is only older than the default branch. Check `gh pr list "
        "--state merged --head <branch>` before deleting one."
    )
    for branch in branches:
        print(f"[{REVIEW:9}] branch {branch}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prune merged Claude session worktrees."
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="remove the worktrees reported as removable (default: report only)",
    )
    parser.add_argument(
        "--orphans",
        action="store_true",
        help="list each landed-looking branch with no worktree (default: a count)",
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

    # Checked in the primary checkout, where the default branch's files are. Silent
    # under --prune: the repo's own session banner reports these trees, and a second
    # verdict from here is the disagreement this check exists to end.
    if (Path(repo) / OWN_PRUNER).is_file():
        if not args.prune:
            print(f"skipped: {repo} prunes its own worktrees with {OWN_PRUNER}")
        return 0

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
        # Last and dearest: a real merge, run only once both history checks have failed.
        contained = (
            not merged
            and not equivalent
            and bool(target)
            and tree.branch is not None
            and is_contained(repo, tree.branch, target)
        )
        verdict, reason = classify(
            tree,
            merged=merged,
            dirty=is_dirty(tree.path),
            is_current=here == resolved or resolved in here.parents,
            equivalent=equivalent,
            contained=contained,
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
    # Same three signals, same order, same policy as the worktree sweep above: only
    # ancestry reaches `-d`; the two weaker signals are reported so the branch is looked
    # at rather than left behind in silence.
    orphan_review = [
        b
        for b in orphans
        if b not in orphan_merged
        and bool(target)
        and (is_equivalent(repo, b, target) or is_contained(repo, b, target))
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
        report_orphans(orphan_review, args.orphans)
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
    report_orphans(orphan_review, args.orphans)
    for tree, error in failed:
        print(f"Could not remove {tree.path}: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
