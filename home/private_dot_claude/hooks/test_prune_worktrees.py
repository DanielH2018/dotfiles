#!/usr/bin/env python3
"""Standalone tests for prune-worktrees.py.

Run: python3 test_prune_worktrees.py

Two halves. The unit half pins the classifier, because everything that keeps this hook
from deleting live work lives there — above all `session_is_alive`, where a wrong answer
costs a sibling session its uncommitted changes.

The end-to-end half builds real git repos in a temp dir and runs the script on them,
because the interesting failure is not in the logic: `git worktree remove` refuses while
a worktree is locked, and Claude Code locks every session worktree, so a version that
never unlocks passes every unit test and removes nothing at all.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Importing the hook below would otherwise write a __pycache__ into the chezmoi source
# tree, which config-soak walks by filesystem and would then track as config.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_prune-worktrees.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "prune-worktrees.py"

spec = importlib.util.spec_from_file_location("prune_worktrees", SCRIPT)
mod = importlib.util.module_from_spec(spec)
# @dataclass resolves annotations through sys.modules, so register before executing.
sys.modules["prune_worktrees"] = mod
spec.loader.exec_module(mod)

# Scrub git's own environment before anything runs. These tests build real repositories
# in a temp dir and drive them with `cwd=`, but GIT_DIR and GIT_WORK_TREE outrank cwd —
# and git exports both to every hook it runs. Under a pre-commit or pre-push hook an
# unscrubbed run therefore aims each `git init`, `git commit` and `git worktree remove`
# at the REAL repository the hook fired in. Scrubbing here covers the `git()` helper and
# every env dict built from os.environ below.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

failures = []
ran = 0


def check(name, condition):
    global ran
    ran += 1
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def wt(path="/w", head="abc", branch="b", locked=False, reason=""):
    return mod.Worktree(path, head, branch, locked, reason)


# ── session_is_alive ──────────────────────────────────────────────────────────

my_pid = os.getpid()
my_start = Path(f"/proc/{my_pid}/stat").read_text().rpartition(")")[2].split()[19]

check(
    "live owner is alive",
    mod.session_is_alive(f"claude session x (pid {my_pid} start {my_start})"),
)
check(
    "reused pid with a different starttime is not alive",
    not mod.session_is_alive(f"claude session x (pid {my_pid} start 1)"),
)
check(
    "vanished pid is not alive",
    not mod.session_is_alive("claude session x (pid 4194303 start 12345)"),
)
check(
    "unparseable lock reason is treated as alive",
    mod.session_is_alive("locked by hand while I debug this"),
)
check("empty lock reason is treated as alive", mod.session_is_alive(""))

# ── classify ──────────────────────────────────────────────────────────────────

check(
    "merged + clean + unlocked is removable",
    mod.classify(wt(), merged=True, dirty=False, is_current=False)[0] == mod.REMOVABLE,
)
check(
    "the session's own worktree is kept even when merged and clean",
    mod.classify(wt(), merged=True, dirty=False, is_current=True)[0] == mod.KEEP,
)
check(
    "a live lock outranks merged + clean",
    mod.classify(
        wt(locked=True, reason=f"claude session x (pid {my_pid} start {my_start})"),
        merged=True,
        dirty=False,
        is_current=False,
    )[0]
    == mod.KEEP,
)
check(
    "a dead owner's lock does not keep a merged tree",
    mod.classify(
        wt(locked=True, reason="claude session x (pid 4194303 start 1)"),
        merged=True,
        dirty=False,
        is_current=False,
    )[0]
    == mod.REMOVABLE,
)
check(
    "dirty is kept",
    mod.classify(wt(), merged=True, dirty=True, is_current=False)[0] == mod.KEEP,
)
check(
    "unmerged is kept",
    mod.classify(wt(), merged=False, dirty=False, is_current=False)[0] == mod.KEEP,
)
check(
    "detached HEAD is kept",
    mod.classify(wt(branch=None), merged=True, dirty=False, is_current=False)[0]
    == mod.KEEP,
)

# ── the removal policy: three conditions act, two weaker signals only report ──────
#
# Ancestry is the only "merged" signal that reaches REMOVABLE. Patch-id equivalence and
# content containment each downgrade "not merged" to REVIEW and nothing more — with any
# of the three conditions failing, they cannot even do that.

check(
    "patch-id equivalence alone is review, never removable",
    mod.classify(wt(), merged=False, dirty=False, is_current=False, equivalent=True)[0]
    == mod.REVIEW,
)
check(
    "content containment alone is review, never removable",
    mod.classify(wt(), merged=False, dirty=False, is_current=False, contained=True)[0]
    == mod.REVIEW,
)
check(
    "the two review reasons are distinct",
    mod.classify(wt(), merged=False, dirty=False, is_current=False, equivalent=True)[1]
    != mod.classify(wt(), merged=False, dirty=False, is_current=False, contained=True)[
        1
    ],
)
check(
    "the content reason names the command that settles it",
    "gh pr list --state merged --head b"
    in mod.classify(wt(), merged=False, dirty=False, is_current=False, contained=True)[
        1
    ],
)
check(
    "a weak signal does not outrank dirty",
    mod.classify(wt(), merged=False, dirty=True, is_current=False, contained=True)[0]
    == mod.KEEP,
)
check(
    "a weak signal does not outrank a live lock",
    mod.classify(
        wt(locked=True, reason=f"claude session x (pid {my_pid} start {my_start})"),
        merged=False,
        dirty=False,
        is_current=False,
        contained=True,
    )[0]
    == mod.KEEP,
)
check(
    "ancestry outranks both weak signals",
    mod.classify(
        wt(),
        merged=True,
        dirty=False,
        is_current=False,
        equivalent=True,
        contained=True,
    )[0]
    == mod.REMOVABLE,
)

# ── merge_tree_says_contained ─────────────────────────────────────────────────

check(
    "contained when the merged tree is the target's tree",
    mod.merge_tree_says_contained("abc123\n", "abc123"),
)
check(
    "not contained when the merged tree differs",
    not mod.merge_tree_says_contained("abc123\n", "def456"),
)
check(
    "empty merge-tree output is no verdict",
    not mod.merge_tree_says_contained("", "abc123"),
)
check(
    "empty target tree is no verdict",
    not mod.merge_tree_says_contained("abc123\n", ""),
)

# ── is_dirty ──────────────────────────────────────────────────────────────────

# A path git cannot read status for stands in for the shared-index failure: the answer
# has to be "dirty", because reading a failure as clean is what would delete live work.
check("is_dirty fails closed when git errors", mod.is_dirty("/nonexistent-path-xyz"))

# ── parse_worktree_list ───────────────────────────────────────────────────────

parsed = mod.parse_worktree_list(
    "worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\n"
    "worktree /repo/.claude/worktrees/one\nHEAD bbb\nbranch refs/heads/wt-one\n"
    "locked claude session one (pid 7 start 9)\n"
)
check("parses both entries", len(parsed) == 2)
check("strips refs/heads/", parsed[1].branch == "wt-one")
check(
    "captures the lock reason",
    parsed[1].lock_reason == "claude session one (pid 7 start 9)",
)

# ── end to end ────────────────────────────────────────────────────────────────


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    )


def build_repo(root):
    """An origin with a default branch, a clone, and four session worktrees in it."""
    origin = root / "origin"
    origin.mkdir()
    git(["init", "-q", "-b", "main", "--bare", "."], origin)

    repo = root / "repo"
    git(["clone", "-q", str(origin), str(repo)], root)
    git(["config", "user.email", "t@t"], repo)
    git(["config", "user.name", "t"], repo)
    (repo / "a").write_text("a\n")
    git(["add", "a"], repo)
    git(["commit", "-qm", "init"], repo)
    git(["push", "-q", "origin", "main"], repo)

    trees = repo / ".claude" / "worktrees"
    trees.mkdir(parents=True)

    # merged + locked by a dead session: the case that only works if we unlock first
    git(["worktree", "add", "-q", "-b", "wt-merged", str(trees / "merged")], repo)
    git(
        [
            "worktree",
            "lock",
            str(trees / "merged"),
            "--reason",
            "claude session merged (pid 4194303 start 1)",
        ],
        repo,
    )
    # merged + locked by THIS process, standing in for a live session
    git(["worktree", "add", "-q", "-b", "wt-live", str(trees / "live")], repo)
    git(
        [
            "worktree",
            "lock",
            str(trees / "live"),
            "--reason",
            f"claude session live (pid {my_pid} start {my_start})",
        ],
        repo,
    )
    # merged but dirty
    git(["worktree", "add", "-q", "-b", "wt-dirty", str(trees / "dirty")], repo)
    (trees / "dirty" / "scratch").write_text("unsaved\n")
    # unmerged: a commit origin/main does not have
    git(["worktree", "add", "-q", "-b", "wt-ahead", str(trees / "ahead")], repo)
    (trees / "ahead" / "b").write_text("b\n")
    git(["add", "b"], trees / "ahead")
    git(["commit", "-qm", "ahead"], trees / "ahead")
    return repo, trees


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    repo, trees = build_repo(root)
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(root / "cfg")}

    report = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check("report exits 0", report.returncode == 0)
    check("report names the removable tree", "1 removable" in report.stdout)
    check("report leaves it on disk", (trees / "merged").exists())

    off = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=repo,
        capture_output=True,
        text=True,
        env={**env, "CLAUDE_WORKTREE_AUTOPRUNE": "0"},
    )
    check("the opt-out removes nothing", (trees / "merged").exists())
    check("the opt-out says so", "disabled" in off.stdout)

    pruned = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=repo,
        capture_output=True,
        text=True,
        env=env,
    )
    check("prune exits 0", pruned.returncode == 0)
    check(
        "removes the merged tree despite its dead owner's lock",
        not (trees / "merged").exists(),
    )
    check("keeps the live session's tree", (trees / "live").exists())
    check("keeps the dirty tree", (trees / "dirty").exists())
    check("keeps the unmerged tree", (trees / "ahead").exists())
    check("reports what it removed", "wt-merged" in pruned.stdout)
    log = (root / "cfg" / "logs" / "sessions.log").read_text()
    check("logs the removal", "event=worktree_pruned" in log and "wt-merged" in log)

    # A second run has nothing to do and must say nothing at all.
    quiet = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=repo,
        capture_output=True,
        text=True,
        env=env,
    )
    check("a no-op prune is silent", quiet.stdout == "")

    # Run from inside a worktree that is itself removable: it must survive.
    git(["worktree", "add", "-q", "-b", "wt-self", str(trees / "self")], repo)
    self_run = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=trees / "self",
        capture_output=True,
        text=True,
        env=env,
    )
    check("never removes the worktree it is running in", (trees / "self").exists())
    check("self run exits 0", self_run.returncode == 0)

    # Outside a git repo: silent, successful, no-op.
    outside = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=tmp,
        capture_output=True,
        text=True,
        env=env,
    )
    check(
        "outside a repo it is a silent no-op",
        outside.returncode == 0 and outside.stdout == "",
    )

# ── branch cleanup and the squash/rebase case ─────────────────────────────────────────
#
# Two failure modes, one fixture. Removing a worktree used to leave its branch behind
# forever, and the ancestor test used to call a squash-merged branch "not merged" and
# say nothing. The second is the one with teeth: the obvious fix — reap on `git cherry`
# equivalence — would delete a branch whose work merely resembles what is on master, so
# the equivalence case must report and never act.


def build_branch_repo(root):
    """An origin plus a clone holding: a merged tree, a squash-merged tree, and three
    branches with no worktree — merged, squash-merged, and genuinely unlanded."""
    origin = root / "origin"
    origin.mkdir()
    git(["init", "-q", "-b", "main", "--bare", "."], origin)

    repo = root / "repo"
    git(["clone", "-q", str(origin), str(repo)], root)
    git(["config", "user.email", "t@t"], repo)
    git(["config", "user.name", "t"], repo)
    (repo / "a").write_text("a\n")
    git(["add", "a"], repo)
    git(["commit", "-qm", "init"], repo)
    git(["push", "-q", "origin", "main"], repo)

    trees = repo / ".claude" / "worktrees"
    trees.mkdir(parents=True)

    # Merged the ordinary way: its worktree AND its branch should both go.
    git(["worktree", "add", "-q", "-b", "worktree-merged", str(trees / "merged")], repo)

    # Squash-merged: a commit of its own, whose patch is then replayed onto main under a
    # different sha. Not an ancestor, but every commit has an equivalent on main.
    git(
        ["worktree", "add", "-q", "-b", "worktree-squashed", str(trees / "squashed")],
        repo,
    )
    (trees / "squashed" / "sq").write_text("sq\n")
    git(["add", "sq"], trees / "squashed")
    git(["commit", "-qm", "squashed work"], trees / "squashed")
    sha = git(["rev-parse", "HEAD"], trees / "squashed").stdout.strip()
    git(["cherry-pick", sha], repo)
    # Reword it. Without this the replay lands on the same parent with the same tree,
    # author, message and second — so git produces the identical sha and the branch is
    # an ancestor after all, which is not the shape being tested. A real squash merge
    # always rewords (GitHub appends the PR number).
    git(["commit", "-q", "--amend", "-m", "squashed work (#1)"], repo)
    git(["push", "-q", "origin", "main"], repo)

    # Three branches with no worktree at all.
    git(["branch", "worktree-orphan-merged", "main"], repo)
    git(["branch", "worktree-orphan-squashed", f"{sha}"], repo)
    git(["branch", "worktree-orphan-live", "main"], repo)
    git(["worktree", "add", "-q", "--detach", str(root / "scratch")], repo)
    (root / "scratch" / "live").write_text("live\n")
    git(["add", "live"], root / "scratch")
    git(["commit", "-qm", "unlanded"], root / "scratch")
    live_sha = git(["rev-parse", "HEAD"], root / "scratch").stdout.strip()
    git(["branch", "-f", "worktree-orphan-live", live_sha], repo)
    git(["worktree", "remove", "--force", str(root / "scratch")], repo)

    # A merged branch that is NOT a session branch: the sweep must not touch it.
    git(["branch", "my-own-branch", "main"], repo)

    # A REAL squash: two commits collapsed into one on main. No commit on main carries
    # either patch-id, so `git cherry` reports both as unlanded — only the content test
    # can see that main already holds everything this branch has.
    git(
        ["worktree", "add", "-q", "-b", "worktree-collapsed", str(trees / "collapsed")],
        repo,
    )
    (trees / "collapsed" / "c1").write_text("c1\n")
    git(["add", "c1"], trees / "collapsed")
    git(["commit", "-qm", "first half"], trees / "collapsed")
    (trees / "collapsed" / "c2").write_text("c2\n")
    git(["add", "c2"], trees / "collapsed")
    git(["commit", "-qm", "second half"], trees / "collapsed")
    git(["merge", "-q", "--squash", "worktree-collapsed"], repo)
    git(["commit", "-qm", "collapsed work (#2)"], repo)
    git(["push", "-q", "origin", "main"], repo)
    # Its orphan twin: same commits, no worktree.
    collapsed_sha = git(["rev-parse", "worktree-collapsed"], repo).stdout.strip()
    git(["branch", "worktree-orphan-collapsed", collapsed_sha], repo)

    # Squash-merged, then main drifted into a conflict on a file the branch touched:
    # merge-tree has no verdict, which must read as not contained.
    git(
        ["worktree", "add", "-q", "-b", "worktree-conflict", str(trees / "conflict")],
        repo,
    )
    (trees / "conflict" / "a").write_text("branch version\n")
    git(["add", "a"], trees / "conflict")
    git(["commit", "-qm", "conflicting edit"], trees / "conflict")
    (repo / "a").write_text("main version\n")
    git(["add", "a"], repo)
    git(["commit", "-qm", "main moved on"], repo)
    git(["push", "-q", "origin", "main"], repo)
    return repo, trees


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    repo, trees = build_branch_repo(root)
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(root / "cfg")}

    check(
        "is_equivalent sees a squash-merged branch",
        mod.is_equivalent(str(repo), "worktree-squashed", "origin/main"),
    )
    check(
        "is_equivalent rejects a branch with unlanded work",
        not mod.is_equivalent(str(repo), "worktree-orphan-live", "origin/main"),
    )
    check(
        "is_equivalent rejects a branch with no commits of its own",
        not mod.is_equivalent(str(repo), "worktree-orphan-merged", "origin/main"),
    )

    # The content signal only earns its place where patch-id says no: the collapsed
    # branch must fail is_equivalent AND pass is_contained, or merge-tree is never the
    # thing being tested.
    check(
        "is_equivalent cannot see a two-commit squash",
        not mod.is_equivalent(str(repo), "worktree-collapsed", "origin/main"),
    )
    check(
        "is_contained sees a two-commit squash",
        mod.is_contained(str(repo), "worktree-collapsed", "origin/main"),
    )
    check(
        "is_contained rejects a branch with unlanded work",
        not mod.is_contained(str(repo), "worktree-orphan-live", "origin/main"),
    )
    check(
        "is_contained has no verdict on a conflict",
        not mod.is_contained(str(repo), "worktree-conflict", "origin/main"),
    )

    report = subprocess.run(
        [sys.executable, str(SCRIPT)], cwd=repo, capture_output=True, text=True, env=env
    )
    check(
        "report names the squash-merged tree for review",
        "worktree-squashed" in report.stdout and "review" in report.stdout,
    )
    check(
        "report names the orphan merged branch",
        "worktree-orphan-merged" in report.stdout,
    )

    pruned = subprocess.run(
        [sys.executable, str(SCRIPT), "--prune"],
        cwd=repo,
        capture_output=True,
        text=True,
        env=env,
    )
    branches = git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo
    ).stdout.split()

    check("the merged worktree is gone", not (trees / "merged").exists())
    check("its branch is deleted too", "worktree-merged" not in branches)
    check(
        "the orphan merged branch is deleted", "worktree-orphan-merged" not in branches
    )
    check(
        "the branch that is not a session branch survives", "my-own-branch" in branches
    )
    check(
        "the orphan branch with unlanded work survives",
        "worktree-orphan-live" in branches,
    )

    # The whole point of the cherry test: it reports, it does not reap. Patch-id
    # equality is not provenance, so acting on it deletes work that only looks landed.
    check("the squash-merged worktree survives", (trees / "squashed").exists())
    check("the squash-merged branch survives", "worktree-squashed" in branches)
    check(
        "the orphan squash-merged branch survives",
        "worktree-orphan-squashed" in branches,
    )
    # Same policy for the content signal: the collapsed tree and its orphan twin are
    # reported, and both are still there afterwards.
    check(
        "report names the collapsed tree for review",
        f"[{mod.REVIEW:9}] {trees / 'collapsed'}" in report.stdout,
    )
    check("the collapsed worktree survives", (trees / "collapsed").exists())
    check("the collapsed branch survives", "worktree-collapsed" in branches)
    check(
        "the orphan collapsed branch is reported, not deleted",
        "worktree-orphan-collapsed" in report.stdout
        and "worktree-orphan-collapsed" in branches,
    )
    check(
        "the conflicting tree is kept without a review line",
        (trees / "conflict").exists() and "worktree-conflict" not in pruned.stdout,
    )
    check(
        "prune says why it kept the squash-merged tree",
        "squash" in pruned.stdout and "worktree-squashed" in pruned.stdout,
    )
    check(
        "prune reports the deleted branches",
        "worktree-merged" in pruned.stdout,
    )
    log = (root / "cfg" / "logs" / "sessions.log").read_text()
    check(
        "logs both branch deletions",
        "event=branch_deleted" in log and "event=orphan_branch_deleted" in log,
    )

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print(f"OK {ran}")
