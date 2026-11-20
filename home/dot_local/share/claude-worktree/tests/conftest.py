"""Fixtures every test gets: no network, no Docker, and no write outside tmp_path."""

import os

import claude_worktree
import claude_worktree_sweep
import pytest


@pytest.fixture(autouse=True)
def _sealed(monkeypatch, tmp_path):
    """Keep a sweep under test off the forge, Docker, the real log and inherited git.

    `GH_BIN=true` answers every forge read with nothing, which is a forge with no
    pull requests. A test that needs one that fails sets `GH_BIN=false`.
    """
    for name in [name for name in os.environ if name.startswith("GIT_")]:
        monkeypatch.delenv(name)
    monkeypatch.setenv("GH_BIN", "true")
    monkeypatch.setenv("DOCKER_BIN", "false")
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
    monkeypatch.delenv("CLAUDE_WORKTREE_AUTOPRUNE", raising=False)
    monkeypatch.setattr(claude_worktree_sweep, "LOG_PATH", tmp_path / "sessions.log")
    # A process-lifetime memo: one test's forge answer must not reach the next.
    monkeypatch.setattr(claude_worktree, "_FORGE_MEMO", {})


@pytest.fixture
def own_processes_only(monkeypatch):
    """Count only readable processes as holders, for a test that removes a tree.

    The slice rule counts an unreadable process of another non-root uid inside this
    uid's login slice as holding every tree. One such process anywhere on the host
    would refuse every removal a test makes.
    """
    monkeypatch.setattr(
        claude_worktree, "_foreign_in_my_slice", lambda entry, uid: False
    )
