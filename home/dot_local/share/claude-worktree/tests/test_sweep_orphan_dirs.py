"""Tests for how `--prune` treats orphan directories under `.claude/worktrees/`.

An orphan is a directory git no longer registers as a worktree. One with no regular
files, or whose every file's content is already in the object store, holds nothing git
lacks and `--prune` removes it. One holding content git never stored is kept and
reported with each such file named. Each test runs `main` against a scratch
repository, so the object-store check runs against real git.

The in-use check reads the real /proc, so a test's own `sleep` holder counts.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import os
import subprocess
from pathlib import Path

import claude_worktree_sweep
from _repo import commit, git, init_repo, land
from claude_worktree_sweep import find_orphan_dirs

# The scratch repo commits this content as `a.txt`, so a copy of it is already stored.
TRACKED_CONTENT = "one\n"


def _repo(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    repo = init_repo(tmp_path / "repo")
    commit(repo, "init", **{"a.txt": TRACKED_CONTENT})
    land(repo, "master")
    monkeypatch.chdir(repo)
    return repo


def _orphan(repo: Path, name: str) -> Path:
    path = repo / ".claude" / "worktrees" / name
    path.mkdir(parents=True)
    return path


def _run(capsys, *argv: str) -> subprocess.CompletedProcess:
    capsys.readouterr()
    code = claude_worktree_sweep.main(list(argv))
    out, err = capsys.readouterr()
    return subprocess.CompletedProcess(argv, code, out, err)


def test_orphan_dirs_are_those_git_does_not_track(tmp_path):
    tracked = tmp_path / "live"
    tracked.mkdir()
    stray = tmp_path / "left-behind"
    stray.mkdir()
    (tmp_path / "notes.txt").write_text("")

    assert find_orphan_dirs(str(tmp_path), {str(tracked)}) == [str(stray)]


def test_missing_worktrees_dir_is_not_an_error(tmp_path):
    assert find_orphan_dirs(str(tmp_path / "absent"), set()) == []


def test_prune_removes_an_orphan_holding_only_empty_directories(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-empty")
    (orphan / "ansible" / "roles").mkdir(parents=True)
    (orphan / "docs").mkdir()

    done = _run(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not orphan.exists(), done.stdout + done.stderr


def test_prune_removes_an_orphan_whose_files_git_already_stores(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-copy")
    (orphan / "a.txt").write_text(TRACKED_CONTENT)
    # The same stored content under another path is still content git holds.
    (orphan / "sub").mkdir()
    (orphan / "sub" / "renamed-copy.txt").write_text(TRACKED_CONTENT)

    done = _run(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not orphan.exists(), done.stdout + done.stderr


def test_prune_keeps_an_orphan_with_unstored_content_and_names_the_file(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-work")
    (orphan / "fresh-content.txt").write_text("work git never stored\n")

    done = _run(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert orphan.is_dir()
    assert "fresh-content.txt" in done.stdout, done.stdout


def test_prune_removes_an_orphan_whose_only_other_file_is_its_gitdir_pointer(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-pointer")
    (orphan / ".git").write_text(f"gitdir: {repo}/.git/worktrees/bridge-pointer\n")
    (orphan / "a.txt").write_text(TRACKED_CONTENT)

    done = _run(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not orphan.exists(), done.stdout + done.stderr


def test_prune_keeps_an_orphan_whose_git_file_holds_more_than_a_pointer(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-not-pointer")
    (orphan / ".git").write_text("gitdir: /elsewhere\nnote git never stored\n")

    done = _run(capsys, "--prune")

    assert orphan.is_dir()
    assert ".git" in done.stdout, done.stdout


def test_a_kept_orphan_names_only_the_files_git_never_stored(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-mixed")
    (orphan / "stored-copy.txt").write_text(TRACKED_CONTENT)
    (orphan / "truncated-template.j2").write_text("cpu_re")

    done = _run(capsys, "--prune")

    assert orphan.is_dir()
    assert "truncated-template.j2" in done.stdout, done.stdout
    assert "stored-copy.txt" not in done.stdout, done.stdout


def test_prune_skips_an_orphan_a_process_still_uses(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # The idle sibling is the same kind of orphan, so it is removed while the held one
    # stays: what keeps the held one is the in-use check, not its content.
    repo = _repo(tmp_path, monkeypatch)
    held = _orphan(repo, "bridge-held")
    (held / "empty").mkdir()
    idle = _orphan(repo, "bridge-idle")
    (idle / "empty").mkdir()

    holder = subprocess.Popen(["sleep", "300"], cwd=held)
    try:
        done = _run(capsys, "--prune")
    finally:
        holder.kill()
        holder.wait()

    # The held orphan is a skip, not a failure: the run names it and exits 0.
    assert done.returncode == 0, done.stderr
    assert f"kept {held}: in use by a live process" in done.stderr
    assert not idle.exists(), done.stdout + done.stderr
    assert held.is_dir(), done.stdout
    assert done.stdout.splitlines()[-1] == (
        "PRUNE-RESULT: removed=1 failed=0 in_use=1 branches=0"
    )


def test_prune_brief_removes_an_empty_orphan_and_keeps_one_with_unstored_content(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # `--prune --brief` is the timer's invocation, so it sweeps orphans as
    # `--prune` does.
    repo = _repo(tmp_path, monkeypatch)
    empty = _orphan(repo, "bridge-empty")
    (empty / "docs").mkdir()
    work = _orphan(repo, "bridge-work")
    (work / "fresh-content.txt").write_text("work git never stored\n")

    done = _run(capsys, "--prune", "--brief")

    assert done.returncode == 0, done.stderr
    assert not empty.exists(), done.stdout + done.stderr
    assert work.is_dir()
    assert f"kept orphan {work}: 1 file(s)" in done.stdout, done.stdout


def test_prune_keeps_an_orphan_whose_blob_is_stored_but_unreachable(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # A staged-then-abandoned file leaves a loose blob no ref reaches, and the gc at the
    # prune's tail deletes it after a day, so the orphan may hold the last copy.
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-staged")
    staged = orphan / "staged-only.txt"
    staged.write_text("staged in a worktree, never committed\n")
    git(repo, "hash-object", "-w", str(staged))

    done = _run(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert orphan.is_dir()
    assert "staged-only.txt" in done.stdout, done.stdout


def test_report_without_prune_names_a_removable_orphan_and_deletes_nothing(
    tmp_path, monkeypatch, capsys
):
    # The report is a dry run: it says the orphan is removable and leaves it in place.
    repo = _repo(tmp_path, monkeypatch)
    orphan = _orphan(repo, "bridge-empty")
    (orphan / "docs").mkdir()

    done = _run(capsys)

    assert done.returncode == 0, done.stderr
    assert orphan.is_dir(), done.stdout
    assert "holds nothing git lacks" in done.stdout, done.stdout
    assert "1 orphan dir(s)" in done.stdout, done.stdout
