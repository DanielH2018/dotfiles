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
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_worktree-landed.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "worktree-landed.sh"

failures = []


def check(name, condition):
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def run(cwd, stop_hook_active=False):
    """Run the hook in cwd; return its decision, or None when it stayed silent."""
    result = subprocess.run(
        ["bash", str(HOOK)],
        cwd=cwd,
        input=json.dumps({"session_id": "test", "stop_hook_active": stop_hook_active}),
        capture_output=True,
        text=True,
        env={**os.environ, "HOOK_INPUT_LIB": str(HERE / "hook-input.sh")},
    )
    if result.returncode != 0:
        return {"error": result.stderr.strip() or f"exit {result.returncode}"}
    return json.loads(result.stdout) if result.stdout.strip() else None


def git(args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    )


def build(root):
    """An origin, a clone, and the four worktree states the hook has to tell apart."""
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

    def worktree(name, *, commit, push, land):
        path = trees / name
        git(["worktree", "add", "-q", "-b", f"wt-{name}", str(path)], repo)
        if commit:
            (path / name).write_text(name)
            git(["add", "."], path)
            git(["commit", "-qm", name], path)
        if push:
            git(["push", "-q", "-u", "origin", f"wt-{name}"], path)
        if land:
            # A merge commit on the default branch — how both real repos land work.
            git(["merge", "-q", "--no-ff", "-m", f"merge {name}", f"wt-{name}"], repo)
            git(["push", "-q", "origin", "main"], repo)
            git(["fetch", "-q", "origin"], repo)
        return path

    return {
        "repo": repo,
        "landed": worktree("landed", commit=True, push=True, land=True),
        "unmerged": worktree("unmerged", commit=True, push=True, land=False),
        "dirty": worktree("dirty", commit=True, push=True, land=True),
        "fresh": worktree("fresh", commit=False, push=False, land=False),
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

    # Detached HEAD has no branch to have landed.
    git(["checkout", "-q", "--detach"], t["landed"])
    check("detached HEAD is silent", run(t["landed"]) is None)

print()
if failures:
    print(f"{len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("all passed")
