#!/usr/bin/env python3
"""Standalone tests for worktree-landed.sh.

Run: python3 test_worktree_landed.py

Feeds the Stop hook a payload on stdin from inside real git worktrees and asserts block
(a JSON decision) vs silence. The contract worth pinning is the silence: this hook fires
at the end of every turn, so a false positive interrupts a working session and tells
it to delete its workspace. The quiet cases outnumber the one that must not be quiet.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_worktree-landed.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "worktree-landed.sh"

# Scrub git's own environment before anything runs. These tests build real repositories
# in a temp dir and drive them with `cwd=`, but GIT_DIR and GIT_WORK_TREE outrank cwd —
# and git exports both to every hook it runs. Under a pre-commit or pre-push hook an
# unscrubbed run therefore aims each `git init` and `git commit` at the REAL repository
# the hook fired in.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

failures = []

# A stand-in for `gh pr list --head <branch> --state merged --json number --jq length`:
# it prints 1 when the branch is listed in $STUB_MERGED, 0 otherwise. Provenance is the
# whole point of that call, so the tests have to be able to state both answers.
STUB_DIR = Path(tempfile.mkdtemp(prefix="worktree-landed-stub-"))
GH_STUB = STUB_DIR / "gh"
MERGED_LIST = STUB_DIR / "merged"
MERGED_LIST.write_text("")
GH_STUB.write_text(
    "#!/bin/bash\n"
    "branch=\n"
    "while [ $# -gt 0 ]; do\n"
    '  case "$1" in --head) branch="$2"; shift 2 ;; *) shift ;; esac\n'
    "done\n"
    'if grep -qxF "$branch" "$STUB_MERGED" 2>/dev/null; then echo 1; else echo 0; fi\n'
)
GH_STUB.chmod(0o755)


def check(name, condition):
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def run(cwd, stop_hook_active=False, **env):
    """Run the hook in cwd; return its decision, or None when it stayed silent.

    GH_BIN points at the stub below by default, so no test reaches the network. The
    squash fallback shells out to `gh` whenever the local ancestor test fails, which
    covers several of the silent cases too, not just the squash ones.
    """
    result = subprocess.run(
        ["bash", str(HOOK)],
        cwd=cwd,
        input=json.dumps({"session_id": "test", "stop_hook_active": stop_hook_active}),
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "HOOK_INPUT_LIB": str(HERE / "hook-input.sh"),
            "GH_BIN": str(GH_STUB),
            "STUB_MERGED": str(MERGED_LIST),
            **env,
        },
    )
    if result.returncode != 0:
        return {"error": result.stderr.strip() or f"exit {result.returncode}"}
    return json.loads(result.stdout) if result.stdout.strip() else None


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    )


def build(root):
    """An origin, a clone, and the worktree states the hook has to tell apart."""
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

    def worktree(name, *, commit, push, land, squash=False):
        path = trees / name
        git(["worktree", "add", "-q", "-b", f"wt-{name}", str(path)], repo)
        if commit:
            (path / name).write_text(name)
            git(["add", "."], path)
            git(["commit", "-qm", name], path)
        if push:
            git(["push", "-q", "-u", "origin", f"wt-{name}"], path)
        if squash:
            # A squash merge: the branch tip is never an ancestor of the default branch,
            # so only the PR record says this landed.
            git(["merge", "-q", "--squash", f"wt-{name}"], repo)
            git(["commit", "-qm", f"squash {name}"], repo)
            git(["push", "-q", "origin", "main"], repo)
            git(["fetch", "-q", "origin"], repo)
        if land:
            # A merge commit on the default branch — how both real repos land work.
            git(["merge", "-q", "--no-ff", "-m", f"merge {name}", f"wt-{name}"], repo)
            git(["push", "-q", "origin", "main"], repo)
            git(["fetch", "-q", "origin"], repo)
        return path

    return {
        "repo": repo,
        "landed": worktree("landed", commit=True, push=True, land=True),
        # A second landed tree, so a check that consumes the one-ask stamp on one of
        # them cannot make a later check pass for the wrong reason.
        "landed2": worktree("landed2", commit=True, push=True, land=True),
        "unmerged": worktree("unmerged", commit=True, push=True, land=False),
        "dirty": worktree("dirty", commit=True, push=True, land=True),
        "fresh": worktree("fresh", commit=False, push=False, land=False),
        "squashed": worktree(
            "squashed", commit=True, push=True, land=False, squash=True
        ),
        # Squash-merged, then worked in again: the tip is no longer the commit the PR
        # record refers to, so the merged PR proves nothing about what is on disk.
        "squashed_then_edited": worktree(
            "squashed-then-edited", commit=True, push=True, land=False, squash=True
        ),
    }


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    t = build(root)
    (t["dirty"] / "scratch").write_text("unsaved\n")

    landed = run(t["landed"])
    check("landed + clean blocks", bool(landed) and landed.get("decision") == "block")
    check(
        "the block names the branch and the tool to call",
        bool(landed)
        and "wt-landed" in landed.get("reason", "")
        and "ExitWorktree" in landed.get("reason", ""),
    )
    check(
        "the block warns off discard_changes",
        bool(landed) and "discard_changes" in landed.get("reason", ""),
    )
    check(
        "the block covers the case where ExitWorktree cannot act",
        bool(landed) and "prune-worktrees.py" in landed.get("reason", ""),
    )
    # Leaving the tree is half the job: the primary checkout still holds the pre-merge
    # commit, and every later session and deploy reads its templates from there.
    check(
        "the block tells the session to fast-forward the primary checkout",
        bool(landed)
        and "pull --ff-only" in landed.get("reason", "")
        and str(t["repo"]) in landed.get("reason", ""),
    )
    # Removing a worktree leaves its branch behind; nothing else deletes it in-session.
    check(
        "the block tells the session to delete the branch with -d, never -D",
        bool(landed)
        and "branch -d wt-landed" in landed.get("reason", "")
        and "Never -D" in landed.get("reason", ""),
    )
    # Both orders are needed, one per merge shape: the pull prunes the tracking ref a
    # squash-merged branch needs, and is the only thing that brings a ff land's
    # tip into the primary's HEAD.
    reason = landed.get("reason", "") if landed else ""
    check(
        "the branch deletion is ordered before the pull",
        "branch -d" in reason
        and "pull --ff-only" in reason
        and reason.index("branch -d") < reason.index("pull --ff-only"),
    )
    check(
        "the block asks for a second -d attempt after the pull",
        "BEFORE the pull" in reason and "AFTER the pull" in reason,
    )

    # Asked once, never again for this tree: merging is often not the end of the work
    # (merge, deploy, verify), and a hook that re-blocks every turn would nag a session
    # that has good reason to stay put.
    check("a later turn on the same worktree is silent", run(t["landed"]) is None)
    check("a second pass in the same cascade is silent", run(t["landed"], True) is None)
    check("uncommitted work is silent", run(t["dirty"]) is None)
    check("an unmerged branch is silent", run(t["unmerged"]) is None)
    check("a fresh never-pushed worktree is silent", run(t["fresh"]) is None)
    check("the primary checkout is silent", run(t["repo"]) is None)
    check("outside a git repo it is silent", run(tmp) is None)

    # A worktree outside .claude/worktrees/ is the operator's, not a session's.
    outside = root / "byhand"
    git(["worktree", "add", "-q", "-b", "wt-byhand", str(outside)], t["repo"])
    git(["push", "-q", "-u", "origin", "wt-byhand"], outside)
    check("a worktree outside .claude/worktrees is silent", run(outside) is None)

    # Detached HEAD has no branch to have landed. Run it on the untouched landed tree,
    # which would otherwise block — so silence here is the detach, not the stamp.
    git(["checkout", "-q", "--detach"], t["landed2"])
    check("detached HEAD is silent", run(t["landed2"]) is None)

    # The squash fallback. Until GitHub says the PR merged, a rewritten tip is
    # indistinguishable from work in progress.
    check(
        "a squash-merged branch is silent while gh reports no merged PR",
        run(t["squashed"]) is None,
    )
    MERGED_LIST.write_text("wt-squashed\nwt-squashed-then-edited\n")
    squashed = run(t["squashed"])
    check(
        "a squash-merged branch blocks once gh reports the PR merged",
        bool(squashed) and squashed.get("decision") == "block",
    )
    check(
        "the squash block says the pull request landed, not that the commits did",
        bool(squashed) and "pull request is merged" in squashed.get("reason", ""),
    )
    check(
        "no gh on PATH is silent",
        run(t["squashed_then_edited"], GH_BIN=str(STUB_DIR / "no-such-gh")) is None,
    )
    check(
        "a gh that fails is silent",
        run(t["squashed_then_edited"], GH_BIN="false") is None,
    )
    # A commit made after the PR merged exists only here, whatever the PR record says.
    (t["squashed_then_edited"] / "later").write_text("later\n")
    git(["add", "."], t["squashed_then_edited"])
    git(["commit", "-qm", "after the merge"], t["squashed_then_edited"])
    check(
        "a commit made after the merge is silent",
        run(t["squashed_then_edited"]) is None,
    )

shutil.rmtree(STUB_DIR, ignore_errors=True)

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all passed")
