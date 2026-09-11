"""tests/hooks/allow-clean-reset.test.js, case for case (12 tests, checked 2026-09-11).

Drives `clean_reset_safe` against REAL temporary git repositories built by `_make_repo`,
mirroring the JS fixture's own `makeRepo()` — not a mock of the cleanliness probe. A test
that stubbed the probe and asserted it was called would pass for a correct and an incorrect
implementation alike; only a real repo can prove the dirty-tree case actually refuses.
"""

import os
import subprocess

import pytest

from claude_guard.checks.git_reset import clean_reset_safe


def _sh(cwd: str, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


def _make_repo(tmp_path, branch: str = "master") -> str:
    """A repo with an `origin` remote whose named branch has moved ahead of the local
    checkout and carries one tracked file, so `reset --hard origin/<branch>` is a real,
    meaningful fast-forward (mirrors the JS fixture's makeRepo())."""
    root = tmp_path
    bare = str(root / "origin.git")
    work = str(root / "work")
    _sh(str(root), "git", "init", "-q", "--bare", bare)
    _sh(str(root), "git", "clone", "-q", bare, work)
    _sh(work, "git", "config", "user.email", "a@b.c")
    _sh(work, "git", "config", "user.name", "a")
    (root / "work" / "README.md").write_text("first\n")
    _sh(work, "git", "add", "README.md")
    _sh(work, "git", "commit", "-q", "-m", "one")
    _sh(work, "git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    _sh(work, "git", "commit", "-q", "--allow-empty", "-m", "two")
    _sh(work, "git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    # Local checkout falls one commit behind origin/<branch>.
    _sh(work, "git", "reset", "-q", "--hard", "HEAD~1")
    _sh(work, "git", "fetch", "-q", "origin")
    return work


# --- the pair set, ported from allow-clean-reset.test.js ---


def test_clean_tree_reset_to_origin_master_is_allowed(tmp_path):
    work = _make_repo(tmp_path)
    assert clean_reset_safe("git reset --hard origin/master", work) is True


def test_clean_tree_reset_to_origin_main_is_allowed(tmp_path):
    work = _make_repo(tmp_path, branch="main")
    assert clean_reset_safe("git reset --hard origin/main", work) is True


def test_quiet_flag_and_trailing_tail_are_still_allowed(tmp_path):
    work = _make_repo(tmp_path)
    assert clean_reset_safe("git reset --hard -q origin/master", work) is True
    assert clean_reset_safe("git reset --hard --quiet origin/master", work) is True
    assert clean_reset_safe("git reset --hard origin/master 2>&1 | tail -n 20", work) is True
    assert clean_reset_safe("git reset --hard origin/master | tail -20", work) is True


def test_a_worktree_not_the_primary_checkout_is_allowed_when_clean(tmp_path):
    work = _make_repo(tmp_path)
    wt_dir = str(tmp_path / "wt")
    _sh(work, "git", "worktree", "add", "-q", "-b", "wt-branch", wt_dir, "origin/master")
    _sh(wt_dir, "git", "fetch", "-q", "origin")
    assert clean_reset_safe("git reset --hard origin/master", wt_dir) is True


def test_a_dirty_tracked_file_is_refused(tmp_path):
    """The rejecting half of the pair: proves the cleanliness probe is load-bearing."""
    work = _make_repo(tmp_path)
    (tmp_path / "work" / "README.md").write_text("local edit\n")
    assert clean_reset_safe("git reset --hard origin/master", work) is False


def test_an_untracked_file_does_not_block_the_reset(tmp_path):
    work = _make_repo(tmp_path)
    (tmp_path / "work" / "scratch.txt").write_text("not tracked\n")
    assert clean_reset_safe("git reset --hard origin/master", work) is True


def test_a_ref_other_than_origin_master_or_origin_main_is_refused(tmp_path):
    work = _make_repo(tmp_path)
    _sh(work, "git", "branch", "-f", "origin/feature", "origin/master")
    assert clean_reset_safe("git reset --hard origin/feature", work) is False


def test_a_bare_sha_is_refused(tmp_path):
    work = _make_repo(tmp_path)
    sha = subprocess.run(
        ["git", "rev-parse", "origin/master"], cwd=work, capture_output=True, text=True, check=True
    ).stdout.strip()
    assert clean_reset_safe(f"git reset --hard {sha}", work) is False


def test_a_chained_command_riding_in_on_the_reset_is_refused(tmp_path):
    work = _make_repo(tmp_path)
    assert clean_reset_safe("git reset --hard origin/master && rm -rf x", work) is False


def test_mid_rebase_is_refused_even_on_a_clean_tree(tmp_path):
    work = _make_repo(tmp_path)
    os.mkdir(os.path.join(work, ".git", "rebase-merge"))
    assert clean_reset_safe("git reset --hard origin/master", work) is False


def test_a_reflog_ref_is_refused(tmp_path):
    work = _make_repo(tmp_path)
    assert clean_reset_safe("git reset --hard origin/master@{1}", work) is False


def test_a_command_substitution_smuggled_into_the_command_is_refused(tmp_path):
    work = _make_repo(tmp_path)
    assert clean_reset_safe("git reset --hard origin/master && echo $(rm -rf /)", work) is False


# --- the rejecting half the JS fixture cannot see: this check runs its own subprocess ---


def test_missing_git_binary_yields_no_opinion(tmp_path, monkeypatch):
    """A `git` that cannot be launched at all is "no opinion", never a crash or an allow."""
    work = _make_repo(tmp_path)
    empty_bin = tmp_path / "empty-bin"
    empty_bin.mkdir()
    monkeypatch.setenv("PATH", str(empty_bin))
    assert clean_reset_safe("git reset --hard origin/master", work) is False


def test_a_non_repo_cwd_yields_no_opinion(tmp_path):
    """`git rev-parse --git-dir` fails outside any repo (non-zero exit) — "no opinion"."""
    not_a_repo = tmp_path / "not-a-repo"
    not_a_repo.mkdir()
    assert clean_reset_safe("git reset --hard origin/master", str(not_a_repo)) is False


def test_a_git_timeout_yields_no_opinion(tmp_path, monkeypatch):
    """A probe that hangs must not be read as either a clean or a dirty tree."""
    work = _make_repo(tmp_path)

    def _hang(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="git", timeout=kwargs.get("timeout", 5))

    monkeypatch.setattr(subprocess, "run", _hang)
    assert clean_reset_safe("git reset --hard origin/master", work) is False


def test_git_status_nonzero_exit_yields_no_opinion(tmp_path, monkeypatch):
    """rev-parse succeeds but the status probe itself fails (e.g. a corrupted index) —
    still "no opinion", not read as a clean tree just because rev-parse worked."""
    work = _make_repo(tmp_path)
    real_run = subprocess.run

    def _fail_status(argv, **kwargs):
        if "status" in argv:
            return subprocess.CompletedProcess(argv, returncode=128, stdout="", stderr="fatal")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(subprocess, "run", _fail_status)
    assert clean_reset_safe("git reset --hard origin/master", work) is False


@pytest.mark.parametrize("bad_cwd", ["", None])
def test_empty_or_falsy_command_is_refused(bad_cwd):
    assert clean_reset_safe("", bad_cwd or "") is False
