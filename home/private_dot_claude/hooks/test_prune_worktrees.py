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

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_prune-worktrees.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "prune-worktrees.py"

spec = importlib.util.spec_from_file_location("prune_worktrees", SCRIPT)
mod = importlib.util.module_from_spec(spec)
# @dataclass resolves annotations through sys.modules, so register before executing.
sys.modules["prune_worktrees"] = mod
spec.loader.exec_module(mod)

failures = []


def check(name, condition):
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

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all passed")
