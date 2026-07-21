#!/usr/bin/env python3
"""Standalone tests for claude-orchestrate arg validation
(run: python3 test_claude_orchestrate.py).

Covers the paths that exit BEFORE a session is spawned, so no real `claude` runs.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ORCH = os.path.join(HERE, "claude-orchestrate")


def run(args, cwd):
    return subprocess.run([ORCH, *args], cwd=cwd, capture_output=True, text=True)


def make_repo(d):
    repo = os.path.join(d, "repo")
    os.makedirs(repo)
    subprocess.run(["git", "init", "-q", repo], check=True)
    return repo


def test_requires_repo_when_missing():
    with tempfile.TemporaryDirectory() as d:  # not a git repo
        p = run([], d)
        assert p.returncode == 1, p.stderr
        assert "a repository is required" in p.stderr, p.stderr


def test_requires_worktree_or_branch():
    with tempfile.TemporaryDirectory() as d:
        repo = make_repo(d)
        p = run([repo], d)
        assert p.returncode == 1, p.stderr
        assert "worktree" in p.stderr and "branch" in p.stderr and "required" in p.stderr, p.stderr


def test_w_requires_name():
    with tempfile.TemporaryDirectory() as d:
        p = run(["-w"], d)
        assert p.returncode == 1
        assert "requires a NAME" in p.stderr, p.stderr


def test_w_and_b_mutually_exclusive():
    with tempfile.TemporaryDirectory() as d:
        repo = make_repo(d)
        p = run(["-w", "x", "-b", "y", repo], d)
        assert p.returncode == 1
        assert "mutually exclusive" in p.stderr, p.stderr


if __name__ == "__main__":
    test_requires_repo_when_missing()
    test_requires_worktree_or_branch()
    test_w_requires_name()
    test_w_and_b_mutually_exclusive()
    print("OK")
