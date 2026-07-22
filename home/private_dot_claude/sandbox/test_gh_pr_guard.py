#!/usr/bin/env python3
"""Standalone tests for gh-pr-guard.sh (run: python3 test_gh_pr_guard.py).

Feeds the hook a PreToolUse Bash payload on stdin with a chosen SANDBOX_BRANCH
and asserts allow (no output) vs deny (structured decision), covering the
branch-scope escapes the guard is meant to close.
"""

import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_gh-pr-guard.sh")
BRANCH = "claude/feat"


def run(command, branch=BRANCH):
    """Invoke the hook; return True if it denied the command."""
    env = dict(os.environ, SANDBOX_REPO_NAME="airflow")
    if branch is not None:
        env["SANDBOX_BRANCH"] = branch
    else:
        env.pop("SANDBOX_BRANCH", None)
    payload = json.dumps({"tool_input": {"command": command}})
    p = subprocess.run(
        ["bash", HOOK],
        input=payload,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert p.returncode == 0, p.stderr
    if not p.stdout.strip():
        return False
    out = json.loads(p.stdout)
    return out["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_allows_scoped_create():
    assert not run("gh pr create --title x --body y")
    assert not run(f"gh pr create --head {BRANCH} --title x")


def test_allows_current_branch_edits():
    assert not run("gh pr edit --add-label ai-assisted")
    assert not run("gh pr comment --body hi")
    assert not run("gh pr ready")


def test_ignores_read_and_unrelated():
    assert not run("gh pr view 123")
    assert not run("gh pr comments 123")  # plural read verb, not `comment`
    assert not run("gh pr list")
    assert not run("ls -la && git status")


def test_fails_closed_without_branch():
    assert run("gh pr create --title x", branch=None)
    assert run("gh pr edit --body x", branch=None)


def test_denies_divergent_head():
    assert run("gh pr create --head other-branch --title x")
    assert run("gh pr create -H other --title x")
    assert run("gh pr create -Hother --title x")
    assert run("gh pr create --head=other --title x")


def test_denies_positional_target():
    assert run("gh pr edit 1234 --body x")
    assert run("gh pr edit https://github.com/o/r/pull/9")
    assert run("gh pr comment some-branch --body x")
    assert run("gh pr ready 55")


def test_denies_cross_repo():
    assert run("gh pr edit --repo other/repo")
    assert run("gh pr create --repo other/repo --title x")
    assert run("gh pr create -R other/repo --title x")
    assert run("gh pr create -Rother/repo --title x")


def test_catches_compound_and_continuation():
    assert run("git push -u origin HEAD && gh pr edit 999")
    assert run("gh pr edit \\\n  1234 --body x")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("OK")
