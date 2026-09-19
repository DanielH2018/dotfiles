#!/usr/bin/env python3
# python-suites: skip -- check()-style runner, no `OK N` count line; wiring it is #545
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

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_isolation-guard.sh")
if not os.path.exists(HOOK):
    HOOK = os.path.join(HERE, "isolation-guard.sh")  # deployed tree, prefix stripped


def decision(file_path, job):
    """Invoke the hook; return 'deny' or None (allowed / no decision)."""
    payload = json.dumps({"tool_input": {"file_path": file_path}})
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
    return "deny" if '"permissionDecision": "deny"' in p.stdout else None


def main():
    failures = 0
    tmp = tempfile.mkdtemp(prefix="isolation-guard-test-")
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
            if actual != expected:
                failures += 1
                print(
                    f"FAIL  expected={expected!r} actual={actual!r}  "
                    f"file={file_path!r} job={job}  ({why})"
                )

        print(f"{len(cases) - failures}/{len(cases)} passed")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
