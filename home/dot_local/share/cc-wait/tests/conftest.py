import os
import subprocess

import pytest


def git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A throwaway git repository with a `.claude/wait-sources/` directory.

    Every GIT_* variable is dropped first: a hook-run git exports GIT_DIR, which `git -C`
    does not override, and a test would then write the real repository's index.
    """
    for var in [v for v in os.environ if v.startswith("GIT_")]:
        monkeypatch.delenv(var)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q")
    (root / ".claude" / "wait-sources").mkdir(parents=True)
    return root


def write_probe(root, name, body, track=True):
    """Write an executable shell probe under `root` and, by default, track it."""
    path = root / ".claude" / "wait-sources" / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    if track:
        git(root, "add", str(path))
    return path
