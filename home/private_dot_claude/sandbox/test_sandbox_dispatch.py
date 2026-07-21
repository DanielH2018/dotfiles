#!/usr/bin/env python3
"""Standalone tests for sandbox-dispatch (run: python3 test_sandbox_dispatch.py).

Stubs claude-sandbox on PATH so the locked invocation shape can be asserted without
Docker, and checks that unsafe/malformed inputs are rejected.
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DISPATCH = os.path.join(HERE, "sandbox-dispatch")


def run(args, extra_path):
    env = dict(os.environ, PATH=extra_path + os.pathsep + os.environ["PATH"])
    return subprocess.run([DISPATCH, *args], env=env,
                          capture_output=True, text=True)


def make_stub(d):
    """A fake claude-sandbox that prints its argv (one per line) and exits 0."""
    stub = os.path.join(d, "claude-sandbox")
    with open(stub, "w", encoding="utf-8") as f:
        f.write('#!/usr/bin/env bash\nfor a in "$@"; do echo "$a"; done\n')
    os.chmod(stub, 0o755)
    return d


def make_repo(d):
    repo = os.path.join(d, "repo")
    os.makedirs(os.path.join(repo, ".git"))
    return repo


def test_locked_shape():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run([repo, "feat-x", "add a null check to foo"], d)
        assert p.returncode == 0, p.stderr
        assert p.stdout.splitlines() == [
            "--worktree", "feat-x", "--exec", "add a null check to foo", repo,
        ], p.stdout


def test_rejects_wrong_arity():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run([repo, "feat-x"], d)  # missing prompt
        assert p.returncode == 2 and "usage" in p.stderr


def test_rejects_bad_worktree():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run([repo, "--no-repos", "prompt"], d)  # flag-like worktree
        assert p.returncode == 2 and "worktree" in p.stderr


def test_rejects_flag_like_prompt():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run([repo, "feat-x", "--shell"], d)
        assert p.returncode == 2 and "prompt" in p.stderr


def test_rejects_non_repo():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        p = run([os.path.join(d, "nope"), "feat-x", "prompt"], d)
        assert p.returncode == 2 and "git repository" in p.stderr


def test_branch_mode_locked_shape():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run(["-b", "feature/login", repo, "wire up the form"], d)
        assert p.returncode == 0, p.stderr
        assert p.stdout.splitlines() == [
            "--branch", "feature/login", "--exec", "wire up the form", repo,
        ], p.stdout


def test_branch_mode_rejects_flag_like_branch():
    with tempfile.TemporaryDirectory() as d:
        make_stub(d)
        repo = make_repo(d)
        p = run(["-b", "--no-repos", repo, "prompt"], d)
        assert p.returncode == 2 and "branch" in p.stderr


if __name__ == "__main__":
    test_locked_shape()
    test_rejects_wrong_arity()
    test_rejects_bad_worktree()
    test_rejects_flag_like_prompt()
    test_rejects_non_repo()
    test_branch_mode_locked_shape()
    test_branch_mode_rejects_flag_like_branch()
    print("OK")
