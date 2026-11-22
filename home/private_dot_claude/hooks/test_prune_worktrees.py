#!/usr/bin/env python3
"""Standalone tests for the worktree pruner behind prune-worktrees.py.

Run: python3 test_prune_worktrees.py

Two halves. The unit half pins the classifier, because everything that keeps the
pruner from deleting live work lives there — above all `session_is_alive`, where a
wrong answer costs a sibling session its uncommitted changes.

The end-to-end half builds real git repos in a temp dir and runs the launcher on
them, because the interesting failure is not in the logic: `git worktree remove`
refuses while a worktree is locked, and Claude Code locks every session worktree, so a
version that never unlocks passes every unit test and removes nothing at all.

The logic lives in the claude-worktree package (`claude_worktree`, the library, and
`claude_worktree_sweep`, the sweep and CLI). The launcher only finds that package.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from _testkit import check, finish, git

try:
    import fcntl
except ImportError:  # Windows: no flock, so the sweep skips its lock
    fcntl = None

# Importing the package below would otherwise write a __pycache__ into the chezmoi
# source tree, which `git status --porcelain` would then see as an untracked file.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_prune-worktrees.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "prune-worktrees.py"

# The launcher imports the pruner from the claude-worktree package. In the source tree
# the package sits beside this file's ancestors and is not deployed on a CI runner, so
# point the launcher at it; the deployed copy has no such sibling and falls through to
# ~/.local/share/claude-worktree. Set before the package loads AND inherited by the
# end-to-end subprocesses below, which is why it goes into os.environ rather than a
# per-call env.
_PACKAGE_SOURCE = HERE.parent.parent / "dot_local" / "share" / "claude-worktree"
if _PACKAGE_SOURCE.is_dir():
    os.environ.setdefault("CLAUDE_WORKTREE_HOME", str(_PACKAGE_SOURCE))
PACKAGE = Path(
    os.environ.get("CLAUDE_WORKTREE_HOME", Path.home() / ".local/share/claude-worktree")
)
sys.path.insert(0, str(PACKAGE))

import claude_worktree as cw  # noqa: E402
import claude_worktree_sweep as sw  # noqa: E402

# Scrub git's own environment before anything runs. These tests build real repositories
# in a temp dir and drive them with `cwd=`, but GIT_DIR and GIT_WORK_TREE outrank cwd —
# and git exports both to every hook it runs. Under a pre-commit or pre-push hook an
# unscrubbed run therefore aims each `git init`, `git commit` and `git worktree remove`
# at the REAL repository the hook fired in. Scrubbing here covers the `git()` helper and
# every env dict built from os.environ below.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]
# Every sweep below would otherwise ask the machine's real Docker daemon for
# containers and the real forge for pull requests. `false` reads as Docker being down
# and as a forge that answers nothing; the checks that need either swap in a fake.
os.environ["DOCKER_BIN"] = "false"
os.environ["GH_BIN"] = "false"


def wt(path="/w", head="abc", branch="b", locked=False, reason=""):
    return cw.Worktree(path, head, branch, locked, reason)


def run(args, cwd, env, stdin=""):
    """Run the launcher; empty `stdin` (a hook input) keeps the sweep from waiting."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=cwd,
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
    )


def fake_proc(root, pid, cwd=None, project_dir=None, other_uid=None):
    """A /proc entry the way the scan reads one.

    A process whose cwd the scan can read has `cwd` and no `environ` (an unreadable one
    is skipped). `other_uid` makes an unreadable process of another user inside this
    user's login slice: `status` and `cgroup` readable, nothing else.
    """
    entry = root / str(pid)
    entry.mkdir(parents=True)
    if cwd is not None:
        os.symlink(cwd, entry / "cwd")
    if project_dir is not None:
        (entry / "environ").write_bytes(
            f"A=b\0CLAUDE_PROJECT_DIR={project_dir}\0".encode()
        )
    if other_uid is not None:
        mine = os.getuid() if hasattr(os, "getuid") else -1
        (entry / "status").write_text(f"Uid:\t{other_uid}\t{other_uid}\t0\t0\n")
        (entry / "cgroup").write_text(f"0::/user.slice/user-{mine}.slice/x\n")
    return entry


def listed_under(stdout, heading):
    """The names a `--check` listing indents under `heading`."""
    names, inside = [], False
    for line in stdout.splitlines():
        if line == heading:
            inside = True
        elif inside and line.startswith("  "):
            names.append(line.strip())
        elif inside:
            break
    return names


# ── a live lock: this process, whose start time /proc reports ───────────────────

# session_is_alive proves a lock's owner is still running by comparing its start time
# against /proc/<pid>/stat, so only Linux can produce a lock that is live by that route.
# This read was unguarded and raised FileNotFoundError at import on macOS, taking the
# whole file down before a single check ran.
#
# The checks below are about ranking — that a live lock outranks merged, clean, and the
# weak signals — not about how liveness is established. So off Linux they use the
# reader's other live verdict: an unparseable reason, which session_is_alive treats as
# live by design, because an unrecognized lock is someone else's and guessing wrong
# destroys work. Same verdict, different route, so the ranking still gets tested
# everywhere. The start-time comparison itself is pinned in the claude-worktree suite,
# which can skip properly under pytest.
HAVE_PROC = Path("/proc/self/stat").exists()

my_pid = os.getpid()
my_start = (
    Path(f"/proc/{my_pid}/stat").read_text().rpartition(")")[2].split()[19]
    if HAVE_PROC
    else ""
)
LIVE_REASON = (
    f"claude session x (pid {my_pid} start {my_start})"
    if HAVE_PROC
    else "locked by hand, unparseable on purpose"
)

# ── classify ──────────────────────────────────────────────────────────────────

check(
    "merged + clean + unlocked is removable",
    cw.classify(wt(), "ancestry", dirty=False, is_current=False)[0] == cw.REMOVABLE,
)
check(
    "the session's own worktree is kept even when merged and clean",
    cw.classify(wt(), "ancestry", dirty=False, is_current=True)[0] == cw.KEEP,
)
check(
    "a live lock outranks merged + clean",
    cw.classify(
        wt(locked=True, reason=LIVE_REASON),
        "ancestry",
        dirty=False,
        is_current=False,
    )[0]
    == cw.KEEP,
)
check(
    "a dead owner's lock does not keep a merged tree",
    cw.classify(
        wt(locked=True, reason="claude session x (pid 4194303 start 1)"),
        "ancestry",
        dirty=False,
        is_current=False,
    )[0]
    == cw.REMOVABLE,
)
check(
    "dirty is kept",
    cw.classify(wt(), "ancestry", dirty=True, is_current=False)[0] == cw.KEEP,
)
check(
    "unmerged is kept",
    cw.classify(wt(), None, dirty=False, is_current=False) == (cw.KEEP, "b not merged"),
)
check(
    "detached HEAD is kept",
    cw.classify(wt(branch=None), "ancestry", dirty=False, is_current=False)[0]
    == cw.KEEP,
)
check(
    "a forge-confirmed tree is removable and says the pull request matched its tip",
    cw.classify(wt(), "forge", dirty=False, is_current=False)
    == (cw.REMOVABLE, "b merged as a pull request from this tip, clean, unlocked"),
)

# What keeps a tree a live process holds is `remove`, which asks `in_use_reason`
# right before it acts; `classify` never sees the process. The scan itself is
# `process_holds`, tested in the claude-worktree suite; these pin how a hold is matched.
check(
    "a hold matches the tree and below it, not a sibling sharing its prefix",
    cw.holds_tree("/w/a/sub", {"/w/a"})
    and cw.holds_tree("/w/a", {"/w/a"})
    and not cw.holds_tree("/w/ab", {"/w/a"}),
)
with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve() / "w"
    proc = Path(tmp).resolve() / "proc"
    proc.mkdir()
    fake_proc(proc, 1, cwd=str(base / "ab"))
    fake_proc(proc, 2, cwd=str(base / "a" / "sub"))
    held = cw.processes_using(str(base / "a"), proc=proc, privileged=lambda _t: None)
    check(
        "processes_using matches the tree and below it, "
        "not a sibling sharing its prefix",
        [pid for pid, _ in held] == [2]
        and cw.processes_using(str(base / "b"), proc=proc, privileged=lambda _t: None)
        == [],
    )

with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve() / "w"
    proc = Path(tmp).resolve() / "proc"
    proc.mkdir()
    fake_proc(proc, 3, project_dir=str(base / "a"))
    held = cw.processes_using(str(base / "a"), proc=proc, privileged=lambda _t: None)
    check(
        "processes_using names which hold matched",
        len(held) == 1
        and held[0][0] == 3
        and held[0][1].startswith("CLAUDE_PROJECT_DIR="),
    )

with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp).resolve() / "w"
    proc = Path(tmp).resolve() / "proc"
    proc.mkdir()
    mine = os.getuid() if hasattr(os, "getuid") else -1
    fake_proc(proc, 4, other_uid=mine + 1000)
    held = cw.processes_using(str(base / "a"), proc=proc, privileged=lambda _t: None)
    check(
        "processes_using counts another uid's unreadable process against any tree",
        cw.holds_tree("", {"/w/a"})
        and len(held) == 1
        and held[0][0] == 4
        and "another uid" in held[0][1],
    )

# ── the removal policy: three conditions act, two weaker signals only report ──────
#
# Ancestry is the only local "merged" signal that reaches REMOVABLE. Patch-id
# equivalence and content containment each downgrade "not merged" to REVIEW and
# nothing more — with any of the three conditions failing, they cannot even do that.

check(
    "patch-id equivalence alone is review, never removable",
    cw.classify(wt(), "patch-id", dirty=False, is_current=False)[0] == cw.REVIEW,
)
check(
    "content containment alone is review, never removable",
    cw.classify(wt(), "content", dirty=False, is_current=False)[0] == cw.REVIEW,
)
check(
    "the two review reasons are distinct",
    cw.classify(wt(), "patch-id", dirty=False, is_current=False)[1]
    != cw.classify(wt(), "content", dirty=False, is_current=False)[1],
)
check(
    "the content reason names the command that settles it",
    "ghread pr list --state merged --search head:b"
    in cw.classify(wt(), "content", dirty=False, is_current=False)[1],
)
check(
    "a weak signal does not outrank dirty",
    cw.classify(wt(), "content", dirty=True, is_current=False)[0] == cw.KEEP,
)
check(
    "a weak signal does not outrank a live lock",
    cw.classify(
        wt(locked=True, reason=LIVE_REASON),
        "content",
        dirty=False,
        is_current=False,
    )[0]
    == cw.KEEP,
)

# ── is_dirty ──────────────────────────────────────────────────────────────────

# A path git cannot read status for stands in for the shared-index failure: the answer
# has to be "dirty", because reading a failure as clean is what would delete live work.
check("is_dirty fails closed when git errors", cw.is_dirty("/nonexistent-path-xyz"))
check(
    "tree_created has no answer, not a traceback, for a vanished tree",
    cw.tree_created("/nonexistent-path-xyz") is None,
)

# ── end to end ────────────────────────────────────────────────────────────────


def add_landed_tree(repo, path, branch):
    """Add a session worktree whose one commit is fast-forwarded onto origin's main.

    That is how bin/land lands a branch, and it leaves the branch moved since it was
    created, so ancestry judges the tree rather than the fresh check.
    """
    git(["worktree", "add", "-q", "-b", branch, str(path), "origin/main"], repo)
    (path / branch).write_text(f"{branch}\n")
    git(["add", branch], path)
    git(["commit", "-qm", f"land {branch}"], path)
    git(["push", "-q", "origin", f"{branch}:main"], path)


def build_repo(root):
    """An origin with a default branch, a clone, and five session worktrees in it."""
    origin = root / "origin"
    origin.mkdir()
    git(["init", "-q", "-b", "main", "--bare", "."], origin)

    repo = root / "repo"
    git(["clone", "-q", str(origin), str(repo)], root)
    git(["config", "user.email", "t@t"], repo)
    git(["config", "user.name", "t"], repo)
    (repo / "a").write_text("a\n")
    git(["add", "a"], repo)
    # Committed a month ago, so a branch cut from it now is young while its tip is old:
    # the fresh check has to read when the branch was created, not when its tip was.
    subprocess.run(
        ["git", "commit", "-qm", "init"],
        cwd=repo,
        check=True,
        env={
            **os.environ,
            "GIT_COMMITTER_DATE": f"{int(time.time()) - 30 * 86400} +0000",
        },
    )
    git(["push", "-q", "origin", "main"], repo)

    trees = repo / ".claude" / "worktrees"
    trees.mkdir(parents=True)

    # merged + locked by a dead session: the case that only works if we unlock first.
    # Its commit lands on main the way bin/land lands one, by fast-forward, so the
    # branch has moved since it was created and ancestry is what judges it.
    git(["worktree", "add", "-q", "-b", "wt-merged", str(trees / "merged")], repo)
    (trees / "merged" / "m").write_text("m\n")
    git(["add", "m"], trees / "merged")
    git(["commit", "-qm", "landed"], trees / "merged")
    git(["push", "-q", "origin", "wt-merged:main"], trees / "merged")
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
    # merged + locked, standing in for a live session. LIVE_REASON is this process's own
    # pid and start time on Linux; elsewhere the unparseable reason the reader also
    # treats as live. Either way the tree must survive, or the rest of this scenario's
    # expectations go with it.
    git(["worktree", "add", "-q", "-b", "wt-live", str(trees / "live")], repo)
    git(
        ["worktree", "lock", str(trees / "live"), "--reason", LIVE_REASON],
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
    # fresh: cut at main's tip and never moved, so it passes the ancestry test before
    # its session has made a single commit
    git(["worktree", "add", "-q", "-b", "wt-fresh", str(trees / "fresh")], repo)
    # The desktop app's fresh tree: the same, but its branch has no reflog at all.
    git(["worktree", "add", "-q", "-b", "claude/desktop", str(trees / "desktop")], repo)
    (repo / ".git" / "logs" / "refs" / "heads" / "claude" / "desktop").unlink()
    return repo, trees


with tempfile.TemporaryDirectory() as tmp:
    # .resolve() because the checks below compare paths against the pruner's own
    # output, and git reports a worktree by its real path. On macOS the temp dir sits
    # under /var/folders, a symlink to /private/var/folders, so an unresolved root makes
    # every such comparison miss on a prefix neither side chose.
    root = Path(tmp).resolve()
    repo, trees = build_repo(root)
    env = {**os.environ, "CLAUDE_CONFIG_DIR": str(root / "cfg")}
    policy_file = repo / sw.POLICY_FILE

    report = run([], repo, env)
    check("report exits 0", report.returncode == 0)
    check(
        "report names the removable tree",
        f"[{cw.REMOVABLE:9}] {(trees / 'merged').as_posix()}" in report.stdout,
    )
    check("report leaves it on disk", (trees / "merged").exists())

    off = run(["--hook"], repo, {**env, "CLAUDE_WORKTREE_AUTOPRUNE": "0"})
    check("the opt-out removes nothing", (trees / "merged").exists())
    check("the opt-out says so", "disabled" in off.stdout)

    # A repo that prunes from its own timer switches the SessionStart sweep off in its
    # policy file. The sweep below, run once the file is gone again, is the other half:
    # the same removable tree does go when the repo's policy leaves the sweep on.
    policy_file.write_text(json.dumps({"session_start": "off"}))
    deferred = run(["--hook"], repo, env)
    check(
        "a repo whose policy switches the session sweep off keeps the tree",
        (trees / "merged").exists() and deferred.returncode == 0,
    )
    check("switching the session sweep off is silent", deferred.stdout == "")
    deferred_report = run([], repo, env)
    check(
        "the report still reports where the session sweep is off",
        f"[{cw.REMOVABLE:9}] {(trees / 'merged').as_posix()}" in deferred_report.stdout,
    )
    # A policy the sweep cannot read is a policy it cannot honour, so it removes
    # nothing rather than guessing what it may delete.
    policy_file.write_text("{not json")
    unreadable = run(["--hook"], repo, env)
    check(
        "a malformed policy file removes nothing, exits 0 and says so",
        (trees / "merged").exists()
        and unreadable.returncode == 0
        and "nothing was pruned" in unreadable.stdout,
    )
    policy_file.unlink()

    # Another sweep holding the lock: this one stands aside, silently.
    if fcntl:
        lock_fd = os.open(repo / ".git" / sw.PRUNE_LOCK, os.O_RDWR | os.O_CREAT)
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        contended = run(["--hook"], repo, env)
        os.close(lock_fd)
        check(
            "a sweep that finds the lock held removes nothing and says nothing",
            (trees / "merged").exists() and contended.stdout == "",
        )
    else:
        print("SKIP 1 lock-contention check: no fcntl, so the sweep takes no lock")

    pruned = run(["--hook"], repo, env)
    check("the session sweep exits 0", pruned.returncode == 0)
    check(
        "removes the merged tree despite its dead owner's lock",
        not (trees / "merged").exists(),
    )
    check("keeps the tree whose lock reads as live", (trees / "live").exists())
    check("keeps the dirty tree", (trees / "dirty").exists())
    check("keeps the unmerged tree", (trees / "ahead").exists())
    check(
        "keeps a fresh tree at main's tip and its branch",
        (trees / "fresh").exists()
        and git(["branch", "--list", "wt-fresh"], repo).stdout.strip() != "",
    )
    check(
        "keeps a fresh tree whose branch has no reflog",
        (trees / "desktop").exists(),
    )
    check(
        "judges a no-reflog tree by ancestry once it is past the grace period",
        not cw.is_fresh(
            str(repo),
            "claude/desktop",
            now=time.time() + cw.FRESH_GRACE_S + 60,
            tree_path=str(trees / "desktop"),
        ),
    )
    check("reports what it removed", "wt-merged" in pruned.stdout)
    log = (root / "cfg" / "logs" / "sessions.log").read_text()
    check("logs the removal", "event=worktree_pruned" in log and "wt-merged" in log)

    # A second run has nothing to do and must say nothing at all.
    quiet = run(["--hook"], repo, env)
    check("a no-op sweep is silent", quiet.stdout == "")

    # Run from inside a worktree that is itself removable: it must survive.
    add_landed_tree(repo, trees / "self", "wt-self")
    self_run = run(["--hook"], trees / "self", env)
    check("never removes the worktree it is running in", (trees / "self").exists())
    check("self run exits 0", self_run.returncode == 0)

    # The desktop app runs SessionStart hooks from the primary checkout while the
    # session starts in its worktree, so the hook's own cwd never names the tree. The
    # hook input's `cwd` and CLAUDE_PROJECT_DIR do, and either one must keep it.
    add_landed_tree(repo, trees / "starting", "wt-starting")
    named = run(
        ["--hook"],
        repo,
        env,
        stdin=json.dumps(
            {"hook_event_name": "SessionStart", "cwd": str(trees / "starting")}
        ),
    )
    check(
        "keeps the tree the hook input's cwd names, run from the primary checkout",
        named.returncode == 0 and (trees / "starting").exists(),
    )
    run(["--hook"], repo, {**env, "CLAUDE_PROJECT_DIR": str(trees / "starting")})
    check(
        "keeps the tree CLAUDE_PROJECT_DIR names, run from the primary checkout",
        (trees / "starting").exists(),
    )

    # A merged, clean, unlocked tree a live process still runs from: the detached
    # land.sh case. Skipped where /proc cannot show a cwd.
    if HAVE_PROC:
        add_landed_tree(repo, trees / "busy", "wt-busy")
        sleeper = subprocess.Popen(["sleep", "60"], cwd=trees / "busy")
        try:
            held = run(["--hook"], repo, env)
            check(
                "keeps a merged tree a live process runs from",
                (trees / "busy").exists(),
            )
            check(
                "says why the busy tree was kept",
                f"pid {sleeper.pid}" in held.stdout and cw.IN_USE in held.stdout,
            )
            check(
                "in_use_reason names the pid and the hold",
                cw.in_use_reason(str(trees / "busy")).startswith(cw.IN_USE)
                and f"pid {sleeper.pid} (cwd " in cw.in_use_reason(str(trees / "busy")),
            )
        finally:
            sleeper.kill()
            sleeper.wait()
        run(["--hook"], repo, env)
        check("removes it once the process exits", not (trees / "busy").exists())

        # A session whose project dir is the tree while its cwd is elsewhere: deleting
        # the tree would break every repo hook it runs.
        add_landed_tree(repo, trees / "project", "wt-project")
        session = subprocess.Popen(
            ["sleep", "60"],
            cwd=tmp,
            env={**env, "CLAUDE_PROJECT_DIR": str(trees / "project")},
        )
        try:
            held = run(["--hook"], repo, env)
            check(
                "keeps a merged tree a live process names as CLAUDE_PROJECT_DIR",
                (trees / "project").exists()
                and "CLAUDE_PROJECT_DIR" in held.stdout
                and f"pid {session.pid}" in held.stdout,
            )
            # The removal itself re-scans, so a hold that appears after the sweep's
            # first scan still stops it.
            tree = next(
                t
                for t in cw.parse_worktree_list(
                    git(["worktree", "list", "--porcelain"], repo).stdout
                )
                if t.branch == "wt-project"
            )
            ok, error = cw.remove(str(repo), tree)
            check(
                "remove() refuses a tree a live process holds",
                not ok
                and error.startswith(cw.IN_USE)
                and f"pid {session.pid}" in error
                and (trees / "project").exists(),
            )
        finally:
            session.kill()
            session.wait()
        ok, _ = cw.remove(str(repo), tree)
        check("remove() removes it once the process exits", ok)
    else:
        print("SKIP 7 live-process checks: no /proc to read a process's cwd from")

    # Outside a git repo: silent, successful, no-op.
    outside = run(["--hook"], tmp, env)
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

    # Merged the ordinary way, a commit fast-forwarded onto main: its worktree AND its
    # branch should both go.
    git(["worktree", "add", "-q", "-b", "worktree-merged", str(trees / "merged")], repo)
    (trees / "merged" / "m").write_text("m\n")
    git(["add", "m"], trees / "merged")
    git(["commit", "-qm", "landed"], trees / "merged")
    git(["merge", "-q", "--ff-only", "worktree-merged"], repo)
    git(["push", "-q", "origin", "main"], repo)

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
    # Created behind main and moved onto it, so it is not fresh: a branch created at
    # main's tip and never moved is the case the fresh check keeps.
    git(["branch", "worktree-orphan-merged", "main~1"], repo)
    git(["branch", "-f", "worktree-orphan-merged", "main"], repo)
    # Its own commit, same patch as the tree's: a forge positive is cached per head sha,
    # so sharing the tree's sha would let the tree's confirmation settle this orphan.
    orphan_sq = git(
        [
            "commit-tree",
            f"{sha}^{{tree}}",
            "-p",
            f"{sha}~1",
            "-m",
            "squashed work, orphan copy",
        ],
        repo,
    ).stdout.strip()
    git(["branch", "worktree-orphan-squashed", orphan_sq], repo)
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
    # Its orphan twin, no worktree: the tree's content in a commit of its own.
    # The merged-verdict cache keys a forge positive on the head sha, so a twin at the
    # SAME sha would inherit the orphan's confirmation and the "another tip" check
    # below would test the cache.
    collapsed_sha = git(
        [
            "commit-tree",
            "worktree-collapsed^{tree}",
            "-p",
            "worktree-collapsed~1",
            "-m",
            "second half, orphan copy",
        ],
        repo,
    ).stdout.strip()
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
    root = Path(tmp).resolve()  # see the note on the first temp root above
    repo, trees = build_branch_repo(root)
    # A stub `gh` answering from a table, empty until the forge block at the end, so no
    # run here reaches the network and every squash case is left to the local signals.
    # It answers the two shapes the forge layer asks: `pr list --json headRefOid`, and
    # the same with `--jq` for one head per line. An `api` compare call fails, so a
    # merged PR counts only where its head is this tip exactly.
    merged_prs = root / "merged-prs.json"
    merged_prs.write_text("[]")
    gh_stub = root / "gh"
    gh_stub.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "if sys.argv[1] == 'api':\n"
        "    sys.exit(1)\n"
        "branch = sys.argv[sys.argv.index('--head') + 1]\n"
        f"rows = json.load(open({str(merged_prs)!r}))\n"
        "heads = [h for b, h in rows if b == branch]\n"
        "if '--jq' in sys.argv:\n"
        "    print('\\n'.join(heads))\n"
        "else:\n"
        "    print(json.dumps([{'headRefOid': h} for h in heads]))\n"
    )
    gh_stub.chmod(0o755)
    if sys.platform == "win32":
        # Windows ignores the shebang, so a .cmd shim runs the stub through python.
        gh_stub.rename(root / "gh.py")
        gh_stub = root / "gh.cmd"
        shim = f'@"{sys.executable}" "{root / "gh.py"}" %*'
        gh_stub.write_text(shim + "\r\n")
    env = {
        **os.environ,
        "CLAUDE_CONFIG_DIR": str(root / "cfg"),
        "GH_BIN": str(gh_stub),
    }
    base = "origin/main"

    # An unlanded branch's merge result is a tree the store has never seen, so a
    # merge-tree run against the real store would add loose objects here. This must be
    # the first merge of that branch: a second run would find the verdict cached.
    def loose_objects():
        counts = git(["count-objects", "-v"], repo).stdout
        return next(ln for ln in counts.splitlines() if ln.startswith("count:"))

    before = loose_objects()
    live_layer = cw.local_layer(str(repo), "worktree-orphan-live", base)
    check(
        "local_layer writes no loose objects into the repository",
        loose_objects() == before,
    )
    check("local_layer rejects a branch with unlanded work", live_layer is None)

    check(
        "local_layer sees a squash-merged branch by patch-id",
        cw.local_layer(str(repo), "worktree-squashed", base) == "patch-id",
    )
    # An ancestor settles at the first rung; the patch-id and content rungs are asked
    # only of a branch ancestry does not settle, so a branch with no commits of its own
    # is never read as an equivalent one.
    check(
        "local_layer reads a branch with no commits of its own as ancestry",
        cw.local_layer(str(repo), "worktree-orphan-merged", base) == "ancestry",
    )
    check(
        "an empty `git cherry` listing is no evidence of a landed branch",
        not cw.cherry_says_landed(""),
    )

    # The content signal only earns its place where patch-id says no: the collapsed
    # branch must fail the patch-id rung AND pass the content rung, or merge-tree is
    # never the thing being tested.
    collapsed_layer = cw.local_layer(str(repo), "worktree-collapsed", base)
    check("patch-id cannot see a two-commit squash", collapsed_layer != "patch-id")
    check("content sees a two-commit squash", collapsed_layer == "content")
    check(
        "local_layer has no verdict on a conflict",
        cw.local_layer(str(repo), "worktree-conflict", base) is None,
    )

    report = run([], repo, env)
    check(
        "report names the squash-merged tree for review",
        "worktree-squashed" in report.stdout and "review" in report.stdout,
    )
    check(
        "report names the orphan merged branch",
        f"[{sw.STALE:9}] worktree-orphan-merged" in report.stdout,
    )

    pruned = run(["--prune"], repo, env)
    branches = git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo
    ).stdout.split()

    check(
        "the full sweep ends on its result line",
        pruned.stdout.splitlines()[-1].startswith("PRUNE-RESULT: removed=1 ")
        and pruned.returncode == 0,
    )
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
        f"[{cw.REVIEW:9}] {(trees / 'collapsed').as_posix()}" in report.stdout,
    )
    check("the collapsed worktree survives", (trees / "collapsed").exists())
    check("the collapsed branch survives", "worktree-collapsed" in branches)
    # Landed-looking orphans are counted by default and itemised only on request: a row
    # each is what flooded a session start once they piled up.
    hooked = run(["--hook"], repo, env)
    listing = run(["--check", "--all"], repo, env)
    reviewable = listed_under(listing.stdout, f"kept ({sw.REVIEWABLE}):")
    check(
        "the orphan collapsed branch is reported, not deleted",
        "worktree-orphan-collapsed" in reviewable
        and "worktree-orphan-collapsed" in branches,
    )
    check(
        "--check --all lists the patch-id orphan too",
        "worktree-orphan-squashed" in reviewable,
    )
    check(
        "the default report counts the orphans instead of naming them",
        "--check --all" in report.stdout
        and "worktree-orphan-collapsed" not in report.stdout
        and "worktree-orphan-squashed" not in report.stdout,
    )
    check(
        "the session sweep counts them too",
        "--check --all" in hooked.stdout
        and "worktree-orphan-collapsed" not in hooked.stdout,
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
        "deleted worktree-merged" in pruned.stdout,
    )
    log = (root / "cfg" / "logs" / "sessions.log").read_text()
    check(
        "logs both branch deletions",
        "event=branch_deleted branch=worktree-merged" in log
        and "event=branch_deleted branch=worktree-orphan-merged" in log,
    )

    # The forge settles what the local signals only flag. GitHub says it merged the
    # squashed tree's exact tip and the collapsed orphan's exact tip, so both go, branch
    # and all. The collapsed TREE's branch name has a merged PR too, but from another
    # tip -- a reused name -- so it stays at review, as does the patch-id orphan, which
    # the forge says nothing about.
    def tip(ref):
        return git(["rev-parse", ref], repo).stdout.strip()

    # The forge's "no" is cached for fifteen minutes, so every run above left one; a
    # run that expects the stub's new answer starts without them.
    def reset_forge_no():
        for key in cw.read_verdicts(str(repo)):
            if key.startswith("forge-no:"):
                cw.record_verdict(str(repo), key, "0")

    merged_prs.write_text(
        json.dumps(
            [
                ["worktree-squashed", tip("worktree-squashed")],
                ["worktree-orphan-collapsed", tip("worktree-orphan-collapsed")],
                ["worktree-collapsed", "0" * 40],
            ]
        )
    )
    reset_forge_no()
    forge_report = run([], repo, env)
    check(
        "report calls the forge-confirmed tree removable",
        f"[{cw.REMOVABLE:9}] {(trees / 'squashed').as_posix()}" in forge_report.stdout
        and "merged as a pull request from this tip" in forge_report.stdout,
    )
    # The merged-verdict cache lives in the git common dir. A forge positive is stored
    # against the exact tip; a PR from another tip, and every forge negative, is kept
    # apart from the local verdict.
    stored = cw.read_verdicts(str(repo))
    check(
        "a forge positive is cached against the tip it confirmed",
        stored.get(cw.verdict_key(str(repo), tip("worktree-squashed"), base))
        == "forge",
    )
    check(
        "a forge negative leaves the local verdict standing and is cached apart",
        stored.get(cw.verdict_key(str(repo), tip("worktree-collapsed"), base))
        == "content"
        and stored.get(
            f"forge-no:{tip('worktree-collapsed')}:worktree-collapsed", ""
        ).isdigit(),
    )
    # With gh down, the cached positive still settles the tree.
    offline = run([], repo, {**env, "GH_BIN": "false"})
    check(
        "a cached forge positive needs no gh call",
        f"[{cw.REMOVABLE:9}] {(trees / 'squashed').as_posix()}" in offline.stdout,
    )
    run(["--prune"], repo, env)
    branches = git(
        ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], repo
    ).stdout.split()
    check("the forge-confirmed worktree is gone", not (trees / "squashed").exists())
    check("its branch is deleted with -D", "worktree-squashed" not in branches)
    check(
        "the forge-confirmed orphan is deleted",
        "worktree-orphan-collapsed" not in branches,
    )
    check(
        "a merged PR from another tip of the same name keeps the tree",
        (trees / "collapsed").exists() and "worktree-collapsed" in branches,
    )
    check(
        "an orphan the forge knows nothing about survives",
        "worktree-orphan-squashed" in branches,
    )

    # A failing forge is no verdict: the tree the stub would confirm stays at review.
    reset_forge_no()
    failed_report = run([], repo, {**env, "GH_BIN": "false"})
    check(
        "a failing gh leaves the collapsed tree at review",
        f"[{cw.REVIEW:9}] {(trees / 'collapsed').as_posix()}" in failed_report.stdout,
    )

# ── the merged-verdict cache ─────────────────────────────────────────────────────

with tempfile.TemporaryDirectory() as tmp:
    vc = Path(tmp).resolve() / "vc"
    vc.mkdir()
    git(["init", "-q", "-b", "main"], vc)
    git(["config", "user.email", "t@t"], vc)
    git(["config", "user.name", "t"], vc)
    (vc / "a").write_text("a\n")
    git(["add", "a"], vc)
    git(["commit", "-qm", "base"], vc)
    git(["checkout", "-q", "-b", "feat"], vc)
    (vc / "f").write_text("f\n")
    git(["add", "f"], vc)
    git(["commit", "-qm", "own work"], vc)
    git(["checkout", "-q", "main"], vc)
    repo_arg = str(vc)
    feat = git(["rev-parse", "feat"], vc).stdout.strip()
    main_tip = git(["rev-parse", "main"], vc).stdout.strip()

    # A recorded verdict answers without the git layers running: record one git would
    # never compute and read it back through local_layer.
    cw.record_verdict(repo_arg, cw.verdict_key(repo_arg, feat, "main"), "content")
    check(
        "a cache hit skips the git layers",
        cw.local_layer(repo_arg, feat, "main") == "content",
    )
    # main's tip is an ancestor of feat, so git would say ancestry; the empty verdict
    # is a recorded "no" and has to answer too.
    cw.record_verdict(repo_arg, cw.verdict_key(repo_arg, main_tip, "feat"), "")
    check(
        "a cache hit skips the git layers, negative verdicts included",
        cw.local_layer(repo_arg, main_tip, "feat") is None,
    )
    # The base moves: the key holds the base's sha, so the recorded "content" for the
    # old base is a miss and git answers afresh.
    (vc / "b").write_text("b\n")
    git(["add", "b"], vc)
    git(["commit", "-qm", "base moved"], vc)
    check(
        "a moved base sha is a miss",
        cw.local_layer(repo_arg, feat, "main") is None,
    )

    cache = cw.verdict_cache_path(repo_arg)
    for junk in ("{not json", "[1, 2]", '{"h:b": 7}'):
        cache.write_text(junk)
        check(
            f"a corrupt cache reads as empty: {junk}", cw.read_verdicts(repo_arg) == {}
        )

    cache.unlink()
    cw.record_verdict(repo_arg, "deadbeef:b", "patch-id")
    cw.record_verdict(repo_arg, "live:b", "content")
    cw.record_verdict(repo_arg, "forge-no:deadbeef:br", "1")
    cw.record_verdict(repo_arg, "forge-no:live:br", "2")
    cw.drop_dead_verdicts(repo_arg, {"live"})
    check(
        "a head that is no longer a ref tip is dropped, forge negatives included",
        cw.read_verdicts(repo_arg) == {"live:b": "content", "forge-no:live:br": "2"}
        and not list(cache.parent.glob("*.tmp")),
    )

# ── compose stacks of removed worktrees ──────────────────────────────────────────

check(
    "compose's default name lowercases and drops what compose drops",
    sw.compose_default_name("/r/.claude/worktrees/Ops_T112.Mark-4bd202")
    == "ops_t112mark-4bd202",
)
check(
    "compose's default name trims leading separators",
    sw.compose_default_name("/r/-_x") == "x",
)

stop, keep = sw.compose_stacks(
    ["/r/wt/a"],
    [
        "a\t/r/wt/a",
        "a\t/r/wt/a",
        "shared\t/r/wt/a",
        "b\t/r/wt/b",
        "\t/r/wt/a",
        "c\t",
    ],
)
check(
    "a removed tree's default-named project is stopped once", stop == [("a", "/r/wt/a")]
)
check("a named project started in it is kept", keep == [("shared", "/r/wt/a")])

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp).resolve()
    repo, trees = build_repo(root)
    calls = root / "docker-calls"
    fake = root / "docker"
    fake.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        "if sys.argv[1] == 'ps':\n"
        f"    print('merged\\t{trees / 'merged'}')\n"
        f"    print('team-stack\\t{trees / 'merged'}')\n"
        f"    print('live\\t{trees / 'live'}')\n"
        "else:\n"
        f"    open({str(calls)!r}, 'a').write(' '.join(sys.argv[1:]) + '\\n')\n"
    )
    fake.chmod(0o755)
    env = {
        **os.environ,
        "CLAUDE_CONFIG_DIR": str(root / "cfg"),
        "DOCKER_BIN": str(fake),
    }
    pruned = run(["--hook"], repo, env)
    deadline = time.monotonic() + 5
    while not calls.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    recorded = calls.read_text().splitlines() if calls.exists() else []
    check(
        "its stack gets compose down with volumes",
        recorded == ["compose --project-name merged down --volumes --remove-orphans"],
    )
    check(
        "a named project in the removed tree is reported, not stopped",
        "kept compose project team-stack" in pruned.stdout,
    )

finish()
