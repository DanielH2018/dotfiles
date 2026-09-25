#!/usr/bin/env python3
"""Standalone tests for isolation-guard.sh.

Run: python3 test_isolation_guard.py

Feeds the hook a PreToolUse Edit/Write payload on stdin and asserts deny vs allow
(no decision). Enforces CLAUDE.md's "Working in isolation" rule: a background job
(CLAUDE_JOB_DIR set) editing a path inside a git checkout that is not under
.claude/worktrees/ must be denied; an interactive session, an edit already inside
.claude/worktrees/, and an edit outside any git repo (scratch space) must not be.
"""

import json
import os
import shutil
import subprocess
import tempfile

from _testkit import check, finish

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_isolation-guard.sh")
if not os.path.exists(HOOK):
    HOOK = os.path.join(HERE, "isolation-guard.sh")  # deployed tree, prefix stripped


def decision(file_path, job, cwd=None):
    """Invoke the hook; return 'deny' or None (allowed / no decision)."""
    return run_hook(file_path, job, cwd)[0]


def reason(file_path, cwd):
    """Invoke the hook as a background job; return the deny reason text."""
    return run_hook(file_path, True, cwd)[1]


def run_hook(file_path, job, cwd):
    payload_obj = {"tool_input": {"file_path": file_path}}
    if cwd is not None:
        payload_obj["cwd"] = cwd
    payload = json.dumps(payload_obj)
    env = dict(os.environ, HOOK_INPUT_LIB=os.path.join(HERE, "hook-input.sh"))
    if job:
        env["CLAUDE_JOB_DIR"] = "/tmp/fake-job-dir"
    else:
        env.pop("CLAUDE_JOB_DIR", None)
    p = subprocess.run(
        ["bash", HOOK],
        input=payload,
        capture_output=True,
        text=True,
        env=env,
    )
    if '"permissionDecision": "deny"' not in p.stdout:
        return None, ""
    return "deny", json.loads(p.stdout)["hookSpecificOutput"][
        "permissionDecisionReason"
    ]


def main():
    # realpath: macOS mkdtemp returns /var/folders/..., but git rev-parse
    # --show-toplevel resolves the /var symlink to /private/var, so the guard
    # names the resolved path.
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="isolation-guard-test-"))
    try:
        # A real git repo standing in for a shared/primary checkout.
        repo = os.path.join(tmp, "repo")
        os.makedirs(repo)
        subprocess.run(["git", "init", "-q", repo], check=True, capture_output=True)
        shared_file = os.path.join(repo, "shared.txt")

        # A worktree-shaped path under .claude/worktrees/ inside that same repo.
        wt_dir = os.path.join(repo, ".claude", "worktrees", "myjob")
        os.makedirs(wt_dir)
        wt_file = os.path.join(wt_dir, "isolated.txt")

        # Scratch space with no git repo at all.
        scratch = os.path.join(tmp, "scratch")
        os.makedirs(scratch)
        scratch_file = os.path.join(scratch, "notes.txt")

        # (file, job, expected, why)
        cases = [
            (
                shared_file,
                True,
                "deny",
                "job editing the shared checkout outside .claude/worktrees/",
            ),
            (
                wt_file,
                True,
                None,
                "job editing a path already under .claude/worktrees/ -- isolated",
            ),
            (
                shared_file,
                False,
                None,
                "interactive session (no CLAUDE_JOB_DIR) is untouched",
            ),
            (
                scratch_file,
                True,
                None,
                "job editing scratch space outside any git repo",
            ),
        ]

        for file_path, job, expected, why in cases:
            actual = decision(file_path, job)
            check(f"{why} (expected {expected!r}, got {actual!r})", actual == expected)

        # A session running from another repository (server#2290): EnterWorktree cannot
        # reach this repo, so the denial names the cross-repo worktree route instead.
        other = os.path.join(tmp, "other")
        os.makedirs(other)
        subprocess.run(["git", "init", "-q", other], check=True, capture_output=True)
        cross = reason(shared_file, other)
        check(
            "cross-repo denial names `worktree add` in the file's repo",
            f"git -C {repo} worktree add" in cross
            and "Retry EnterWorktree" not in cross,
        )
        # A session in this repo's own worktree dir keeps the EnterWorktree instruction.
        same = reason(shared_file, wt_dir)
        check(
            "same-repo denial keeps `Retry EnterWorktree`",
            "Retry EnterWorktree" in same and "worktree add" not in same,
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    finish()


if __name__ == "__main__":
    main()
