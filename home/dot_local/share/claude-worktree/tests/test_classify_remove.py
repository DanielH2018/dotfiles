"""Tests for `classify`, `remove`, `primary_checkout`, foreign-owned advice, and repair.

`remove` runs real git against scratch repositories, because a mock proves call
order and nothing about whether the tree is gone.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import os
import shutil
import subprocess
from contextlib import contextmanager
from pathlib import Path

import claude_worktree
import pytest
from _repo import commit, git, git_out, init_repo
from claude_worktree import (
    KEEP,
    REMOVABLE,
    REVIEW,
    Worktree,
    classify,
    foreign_owned_advice,
    foreign_owned_paths,
    is_dirty,
    kept_reason,
    primary_checkout,
    remove,
    repair_object_store,
)

DEAD_LOCK = "claude session gone (pid 1 start 999999999)"


@pytest.fixture(autouse=True)
def _no_root_helper(monkeypatch):
    """Take the root helper out of `remove`'s in-use check, so only /proc answers it."""
    monkeypatch.setattr(claude_worktree, "privileged_holders", lambda tree: None)


def _live_lock_reason() -> str:
    """A lock reason naming this process, which is by definition still running."""
    pid = os.getpid()
    start = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[19]
    return f"claude session mine (pid {pid} start {start})"


def _tree(branch="worktree-x", locked=False, reason="") -> Worktree:
    return Worktree(
        path="/w", head="abc", branch=branch, locked=locked, lock_reason=reason
    )


# --- classify -------------------------------------------------------------------------


def test_merged_clean_unlocked_is_removable():
    verdict, _ = classify(_tree(), "ancestry", False)
    assert verdict == REMOVABLE


def test_a_live_lock_wins_over_a_merged_branch():
    # A session may still be working past its own merge; the lock is how it says so.
    tree = _tree(locked=True, reason=_live_lock_reason())
    verdict, reason = classify(tree, "ancestry", False)
    assert verdict == KEEP
    assert "in use" in reason


def test_a_stale_lock_does_not_keep_a_merged_worktree():
    # Claude Code never releases the lock when a session ends, so obeying every lock
    # would keep every abandoned worktree for ever.
    verdict, _ = classify(_tree(locked=True, reason=DEAD_LOCK), "ancestry", False)
    assert verdict == REMOVABLE


def test_a_stale_lock_still_does_not_override_uncommitted_work():
    verdict, reason = classify(_tree(locked=True, reason=DEAD_LOCK), "ancestry", True)
    assert verdict == KEEP
    assert "uncommitted" in reason


def test_uncommitted_changes_are_never_removed():
    verdict, reason = classify(_tree(), "ancestry", True)
    assert verdict == KEEP
    assert "uncommitted" in reason


def test_unmerged_branch_is_kept():
    verdict, reason = classify(_tree(), None, False)
    assert verdict == KEEP
    assert reason == "worktree-x not merged"


def test_detached_head_is_kept_rather_than_guessed_about():
    verdict, reason = classify(_tree(branch=None), "ancestry", False)
    assert verdict == KEEP
    assert "detached" in reason


def test_removable_reason_names_the_dead_lock_owner_not_unlocked():
    # At classify time the tree is still locked; only `remove` unlocks it later. The
    # reason must say what is true.
    verdict, reason = classify(_tree(locked=True, reason=DEAD_LOCK), "ancestry", False)
    assert verdict == REMOVABLE
    assert "lock owner is dead" in reason


def test_removable_reason_for_a_never_locked_tree_says_unlocked():
    verdict, reason = classify(_tree(), "ancestry", False)
    assert verdict == REMOVABLE
    assert reason.endswith("unlocked")


def test_a_forge_landed_tree_is_removable_with_the_forge_named():
    verdict, reason = classify(_tree(), "forge", False)
    assert verdict == REMOVABLE
    assert "merged as a pull request from this tip" in reason


def test_a_layer_the_caller_does_not_let_act_is_reported_for_review():
    verdict, _ = classify(_tree(), "patch-id", False)
    assert verdict == REVIEW


def test_a_fresh_branch_is_kept_whatever_the_layer_says():
    verdict, reason = classify(_tree(), "ancestry", False, fresh=True)
    assert verdict == KEEP
    assert reason == "worktree-x has no commits of its own yet"


def test_the_callers_own_tree_is_kept_before_any_other_check():
    assert kept_reason(_tree(), False, is_current=True) == "this session's own worktree"
    assert kept_reason(_tree(), False) is None


# --- remove ---------------------------------------------------------------------------


def _scratch_repo(path: Path) -> Path:
    init_repo(path)
    commit(path, "init", **{"a.txt": "one\n"})
    return path


def _add_tree(tmp_path: Path, name: str = "wt", branch: str = "feature") -> Path:
    repo = tmp_path / "repo"
    if not repo.exists():
        _scratch_repo(repo)
    wt = tmp_path / name
    git(repo, "worktree", "add", "-q", "-b", branch, str(wt))
    return wt


def test_remove_actually_deletes_a_locked_worktree_on_disk(
    tmp_path, own_processes_only
):
    # Without the unlock, `git worktree remove` on a locked tree fails outright and the
    # caller would report success while removing nothing.
    wt = _add_tree(tmp_path)
    git(tmp_path / "repo", "worktree", "lock", str(wt), "--reason", "test lock")

    ok, err = remove(
        str(tmp_path / "repo"),
        Worktree(path=str(wt), head="x", branch="feature", locked=True),
    )

    assert ok, err
    assert not wt.exists()


def test_remove_deletes_a_never_locked_worktree_on_disk(tmp_path, own_processes_only):
    # The unlocked half of the pair above: no lock to release, and the tree still goes.
    wt = _add_tree(tmp_path)

    ok, err = remove(
        str(tmp_path / "repo"),
        Worktree(path=str(wt), head="x", branch="feature", locked=False),
    )

    assert ok, err
    assert not wt.exists()


def test_remove_never_forces_past_an_untracked_file(tmp_path, own_processes_only):
    # `--force` is the escape hatch git's docs suggest for a locked tree; using it would
    # remove the safety net that makes the auto-unlock acceptable. A REMOVABLE tree is
    # only known clean as of the read, so git's own refusal on a file that appeared
    # since is the backstop, and this is the one input where it must fire.
    wt = _add_tree(tmp_path)
    git(tmp_path / "repo", "worktree", "lock", str(wt), "--reason", "test lock")
    (wt / "scratch.txt").write_text("unlanded\n")

    ok, err = remove(
        str(tmp_path / "repo"),
        Worktree(path=str(wt), head="x", branch="feature", locked=True),
    )

    assert not ok
    assert "untracked" in err or "modified" in err, err
    assert (wt / "scratch.txt").exists()


@contextmanager
def _sleeper(cwd: Path, project_dir: "Path | None" = None):
    """A live process with `cwd`, and `CLAUDE_PROJECT_DIR` if given, killed on exit."""
    env = dict(os.environ)
    env.pop("CLAUDE_PROJECT_DIR", None)
    if project_dir is not None:
        env["CLAUDE_PROJECT_DIR"] = str(project_dir)
    proc = subprocess.Popen(["sleep", "60"], cwd=cwd, env=env)
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait()


def _locked_paths(repo: Path) -> set[str]:
    trees = git_out(repo, "worktree", "list", "--porcelain").split("\n\n")
    return {
        t.splitlines()[0].removeprefix("worktree ") for t in trees if "\nlocked" in t
    }


def test_remove_refuses_a_tree_a_live_process_has_as_cwd_is_flagged(tmp_path):
    # A session deleted out from under itself loses every repo hook. The lock here
    # names no live owner, so classify would call the tree REMOVABLE; the process is
    # what still uses it.
    wt = _add_tree(tmp_path)
    repo = tmp_path / "repo"
    git(repo, "worktree", "lock", str(wt), "--reason", "test lock")

    with _sleeper(cwd=wt) as proc:
        ok, err = remove(
            str(repo), Worktree(path=str(wt), head="x", branch="feature", locked=True)
        )

    assert not ok
    assert f"pid {proc.pid}" in err, err
    assert wt.exists()
    # The refusal comes before the unlock, so a refused removal leaves the lock as
    # it was.
    assert str(wt) in _locked_paths(repo)


def test_remove_refuses_a_tree_a_live_session_names_as_project_dir_is_flagged(
    tmp_path,
):
    wt = _add_tree(tmp_path)

    with _sleeper(cwd=tmp_path, project_dir=wt) as proc:
        ok, err = remove(
            str(tmp_path / "repo"),
            Worktree(path=str(wt), head="x", branch="feature", locked=False),
        )

    assert not ok
    assert f"pid {proc.pid}" in err and "CLAUDE_PROJECT_DIR" in err, err
    assert wt.exists()


def test_a_process_in_a_sibling_tree_does_not_block_removal_is_clean(
    tmp_path, own_processes_only
):
    # `wt2` shares `wt`'s string prefix, so a startswith match would refuse here. The
    # sleeper's project dir is the repo, the parent of every tree, as the primary
    # checkout's session's is.
    wt = _add_tree(tmp_path, "wt", "feature")
    _add_tree(tmp_path, "wt2", "other")
    repo = tmp_path / "repo"

    with _sleeper(cwd=tmp_path / "wt2", project_dir=repo):
        ok, err = remove(
            str(repo), Worktree(path=str(wt), head="x", branch="feature", locked=False)
        )

    assert ok, err
    assert not wt.exists()


def test_remove_still_deregisters_a_deleted_tree_a_session_names_is_clean(tmp_path):
    # The directory is already gone and a live session still points at it. Deregistering
    # cannot hurt that session further.
    wt = _add_tree(tmp_path)
    repo = tmp_path / "repo"
    shutil.rmtree(wt)

    with _sleeper(cwd=tmp_path, project_dir=wt):
        ok, err = remove(
            str(repo), Worktree(path=str(wt), head="x", branch="feature", locked=False)
        )

    assert ok, err
    assert str(wt) not in git_out(repo, "worktree", "list", "--porcelain")


# --- is_dirty -------------------------------------------------------------------------


def test_a_clean_tree_is_clean_and_an_untracked_file_is_flagged(tmp_path):
    repo = _scratch_repo(tmp_path / "repo")
    assert not is_dirty(str(repo))
    (repo / "scratch.txt").write_text("unlanded\n")
    assert is_dirty(str(repo))


def test_a_path_git_cannot_read_is_flagged_as_dirty(tmp_path):
    # `git status` failing is usually another session mid-write, and reading that as
    # clean is the one wrong answer that costs work.
    assert is_dirty(str(tmp_path / "vanished"))
    assert is_dirty(str(tmp_path))


# --- primary_checkout -----------------------------------------------------------------


def test_primary_checkout_from_a_linked_worktree_is_the_primary_is_clean(tmp_path):
    wt = _add_tree(tmp_path)
    assert primary_checkout(str(wt)) == str((tmp_path / "repo").resolve())


def test_primary_checkout_of_a_separated_git_dir_is_flagged_as_none(tmp_path):
    # The common dir's parent is the directory holding the git dir, which is not a
    # checkout: a sweep would read `<that>/.claude/worktrees/` in a directory git
    # does not consider a repo.
    checkout = tmp_path / "checkout"
    git(
        tmp_path,
        "init",
        "-q",
        f"--separate-git-dir={tmp_path / 'store'}",
        str(checkout),
    )
    assert primary_checkout(str(checkout)) is None


# --- foreign-owned paths --------------------------------------------------------------


def _venv_with_pycache(root: Path) -> tuple[Path, Path]:
    pycache = root / ".venv" / "cryptography" / "x509" / "__pycache__"
    pycache.mkdir(parents=True)
    (pycache / "base.cpython-314.pyc").write_text("")
    stray = root / ".venv" / "a b.cpython-314.pyc"
    stray.write_text("")
    (root / "README.md").write_text("")
    return pycache, stray


def _root_owns(*paths: Path):
    """An `owner` reporting uid 0 for `paths`: a test cannot chown without sudo."""
    root_owned = {str(p) for p in paths}
    return lambda path: 0 if path in root_owned else os.getuid()


def test_a_tree_we_own_throughout_is_clean(tmp_path):
    _venv_with_pycache(tmp_path)
    assert foreign_owned_paths(str(tmp_path)) == []
    assert foreign_owned_advice(str(tmp_path)) == []


def test_a_root_owned_dir_is_flagged_but_not_its_contents(tmp_path):
    pycache, stray = _venv_with_pycache(tmp_path)
    owner = _root_owns(pycache, pycache / "base.cpython-314.pyc", stray)
    assert foreign_owned_paths(str(tmp_path), owner) == sorted(
        [str(pycache), str(stray)]
    )


def test_a_root_that_does_not_exist_is_clean():
    assert foreign_owned_paths("/nonexistent/worktree") == []


def test_the_advice_names_each_path_and_one_quoted_sudo_rm(tmp_path):
    pycache, stray = _venv_with_pycache(tmp_path)
    lines = foreign_owned_advice(str(tmp_path), _root_owns(pycache, stray))
    assert f"    {pycache}" in lines
    assert (
        lines[-1]
        == f"  → an operator clears them with: sudo rm -rf -- '{stray}' {pycache}"
    )


# --- the object-store repair ----------------------------------------------------------
#
# Real git rather than mocks, because what is asserted is what git DELETES: a mocked
# `git prune` proves the argv and nothing about whether the grace period holds.

# An mtime `git prune --expire=1.day.ago` reads as old under any clock. The fresh case
# leaves the mtime alone: a file just written is new by construction.
LONG_AGO = 946_684_800.0  # 2000-01-01T00:00:00Z


def _unreachable_object(repo: Path, text: str, stale: bool) -> Path:
    """Write an unreferenced loose object, backdated if `stale`, and return its file."""
    blob = repo / "loose.txt"
    blob.write_text(text)
    sha = git_out(repo, "hash-object", "-w", "loose.txt")
    blob.unlink()
    path = repo / ".git" / "objects" / sha[:2] / sha[2:]
    assert path.exists(), path
    if stale:
        os.utime(path, (LONG_AGO, LONG_AGO))
    return path


def test_the_repair_drops_an_old_unreachable_object_and_clears_the_gc_log(tmp_path):
    # Both halves matter. While gc.log is there and fresh, `git gc --auto` prints it and
    # exits however clean the store has since become.
    repo = _scratch_repo(tmp_path / "repo")
    stale = _unreachable_object(repo, "left by a removed worktree\n", stale=True)
    gc_log = repo / ".git" / "gc.log"
    gc_log.write_text("warning: There are too many unreachable loose objects\n")

    lines = repair_object_store(repo)

    assert not stale.exists(), lines
    assert not gc_log.exists(), lines
    assert any("automatic gc" in line for line in lines), lines


def test_the_repair_leaves_an_object_a_live_session_just_wrote(tmp_path):
    # Several sessions write into one object store at once. An object one of them has
    # written but not yet pointed a ref at is unreachable and brand new; deleting it
    # destroys live work, so the prune runs on a day's grace and never `--expire=now`.
    repo = _scratch_repo(tmp_path / "repo")
    fresh = _unreachable_object(repo, "another session is mid-commit\n", stale=False)

    repair_object_store(repo)

    assert fresh.exists()


def test_the_repair_clears_the_gc_log_in_the_shared_git_directory(tmp_path):
    # A worktree has a private git directory; gc.log only ever lives in the shared one.
    wt = _add_tree(tmp_path)
    gc_log = tmp_path / "repo" / ".git" / "gc.log"
    gc_log.write_text("warning: There are too many unreachable loose objects\n")

    lines = repair_object_store(wt)

    assert not gc_log.exists(), lines


def test_a_missing_gc_log_is_not_reported_as_a_repair(tmp_path):
    # The common case prints only the prune line, so a caller's report stays quiet.
    repo = _scratch_repo(tmp_path / "repo")

    lines = repair_object_store(repo)

    assert not any("gc.log" in line for line in lines), lines
