"""Drives the worktree cleanup checks against a real `git worktree add` under
`.claude/worktrees/`, so the tracked-file probe and the toplevel test run real git."""

import os
import subprocess

import pytest

from claude_guard.checks.worktree_scratch import worktree_restore_safe, worktree_rm_safe
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots


def _sh(cwd, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    """(primary checkout, session worktree), each holding a tracked `src/app.py` and the
    worktree an untracked `.git-pr-body.md` and `scratch/probe.py`."""
    main = tmp_path / "repo"
    (main / "src").mkdir(parents=True)
    _sh(main, "git", "init", "-q")
    _sh(main, "git", "config", "user.email", "a@b.c")
    _sh(main, "git", "config", "user.name", "a")
    (main / "src" / "app.py").write_text("x = 1\n")
    # The homelab repo's shape: a root catch-all ignores every new root entry, and a few
    # specific rules name state. `.gitignore` itself and `src/` are re-included.
    (main / ".gitignore").write_text("/*\n!/.gitignore\n!/src/\nlocal.cfg\n*.tmp\n")
    _sh(main, "git", "add", "src/app.py", ".gitignore")
    _sh(main, "git", "commit", "-q", "-m", "one")
    wt = main / ".claude" / "worktrees" / "fanout-1"
    _sh(main, "git", "worktree", "add", "-q", str(wt))
    (wt / ".git-pr-body.md").write_text("body\n")
    (wt / "scratch").mkdir()
    (wt / "scratch" / "probe.py").write_text("print(1)\n")
    (wt / "src" / "app.py").write_text("x = 2\n")
    return str(main), str(wt)


def test_rm_of_untracked_files_in_a_session_worktree_is_allowed(repo):
    _, wt = repo
    for command in [
        "rm .git-pr-body.md",
        "rm -f .git-pr-body.md",
        "rm -r scratch",
        "rm -rf scratch/probe.py .git-pr-body.md",
        f"rm {wt}/.git-pr-body.md",
    ]:
        assert worktree_rm_safe(command, wt, cwd_changed=False, project_dir=wt), command


def test_rm_of_anything_tracked_or_outside_the_worktree_is_refused(repo, tmp_path):
    main, wt = repo
    os.symlink(tmp_path, os.path.join(wt, "escape"))
    for command in [
        "rm src/app.py",
        "rm -r src",
        "rm .git",
        "rm -rf .",
        "rm ../../../src/app.py",
        f"rm {main}/src/app.py",
        "rm -r escape/repo",
        "rm scratch/*.py",
        "rm --no-preserve-root -rf scratch",
    ]:
        assert not worktree_rm_safe(command, wt, cwd_changed=False, project_dir=wt), command


def test_cleanup_outside_a_session_worktree_gets_no_opinion(repo, tmp_path):
    main, _ = repo
    (tmp_path / "repo" / "notes.md").write_text("n\n")
    assert not worktree_rm_safe("rm notes.md", main, cwd_changed=False, project_dir=main)
    assert not worktree_restore_safe("git restore src/app.py", main, False, main)


def test_a_relative_operand_after_a_cd_is_refused_and_an_absolute_one_is_not(repo):
    _, wt = repo
    assert not worktree_rm_safe("rm .git-pr-body.md", wt, cwd_changed=True, project_dir=wt)
    assert worktree_rm_safe(f"rm {wt}/.git-pr-body.md", wt, cwd_changed=True, project_dir=wt)
    assert not worktree_restore_safe("git restore src/app.py", wt, cwd_changed=True, project_dir=wt)


def test_git_restore_of_tracked_files_to_head_is_allowed(repo):
    _, wt = repo
    for command in [
        "git restore src/app.py",
        "git restore --staged --worktree src/app.py",
        "git restore --source=HEAD --staged --worktree src/app.py",
        "git restore -s HEAD -- src/app.py",
        f"git restore {wt}/src/app.py",
    ]:
        assert worktree_restore_safe(command, wt, cwd_changed=False, project_dir=wt), command


def test_git_restore_from_another_source_or_with_other_options_is_refused(repo):
    main, wt = repo
    for command in [
        "git restore",
        "git restore --source=main src/app.py",
        "git restore -s HEAD~1 src/app.py",
        "git restore -p src/app.py",
        "git restore ':(glob)src/*'",
        f"git restore {main}/src/app.py",
        "git restore .",
    ]:
        assert not worktree_restore_safe(command, wt, cwd_changed=False, project_dir=wt), command


def test_the_judge_resolves_both_ask_rules_inside_a_session_worktree(repo, tmp_path):
    main, wt = repo
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        '{"permissions": {"allow": ["Bash(git status:*)"],'
        ' "ask": ["Bash(rm:*)", "Bash(git restore:*)"]}}'
    )
    rules = load_rules(home=str(home), project_dir=None)
    roots = scratch_roots(str(home))
    command = "rm .git-pr-body.md && git restore src/app.py && git status --short"
    assert judge(command, rules, roots, wt, wt).allow
    assert not judge(command, rules, roots, main, main).allow
    assert not judge(command, rules, roots, wt, "").allow


def test_cleanup_in_another_sessions_worktree_is_refused(repo):
    main, wt = repo
    other = os.path.join(main, ".claude", "worktrees", "fanout-2")
    _sh(main, "git", "worktree", "add", "-q", other)
    with open(os.path.join(wt, "mine.txt"), "w") as f:
        f.write("x\n")
    assert not worktree_rm_safe("rm .git-pr-body.md", wt, False, project_dir=other)
    assert not worktree_restore_safe("git restore src/app.py", wt, False, project_dir=other)
    assert worktree_rm_safe("rm mine.txt", wt, False, project_dir=os.path.join(wt, "src"))


def test_rm_of_an_ignored_path_or_a_directory_holding_one_is_refused(repo):
    _, wt = repo
    for rel in [
        "local.cfg",
        "src/cache.tmp",
        ".venv/bin/python",
        ".env",
        ".env.local",
        "ansible/vars/cluster-vars.sops.env",
        "tools/id_rsa",
        ".fanout/batch/out.txt",
        ".fanout/batch/.env",
        "plain/notes.txt",
        "plain/.venv/lib/x",
    ]:
        path = os.path.join(wt, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as f:
            f.write("x\n")
    # The root catch-all ignores every one of these, so it must not by itself refuse scratch.
    for command in [
        "rm .git-pr-body.md",
        "rm -r scratch",
        "rm -r plain/notes.txt",
        "rm -r .fanout/batch/out.txt",
    ]:
        assert worktree_rm_safe(command, wt, cwd_changed=False, project_dir=wt), command
    for command in [
        "rm local.cfg",
        "rm src/cache.tmp",
        "rm -r .venv",
        "rm -rf .venv/bin",
        "rm .env",
        "rm -f .env.local",
        "rm -r ansible",
        "rm tools/id_rsa",
        "rm -r plain",
        "rm -r .fanout",
        "rm .fanout/batch/.env",
    ]:
        assert not worktree_rm_safe(command, wt, cwd_changed=False, project_dir=wt), command


def test_a_glob_or_a_directory_is_not_a_tracked_file_to_restore(repo):
    _, wt = repo
    with open(os.path.join(wt, "src", "extra.py"), "w") as f:
        f.write("y = 1\n")
    sub = os.path.join(wt, "src")
    assert worktree_restore_safe("git restore app.py", sub, False, project_dir=wt)
    for cwd, command in [
        (wt, "git restore '*'"),
        (wt, "git restore 'src/*.py'"),
        (wt, "git restore 'src/app.p[y]'"),
        (wt, "git restore src"),
        (wt, "git restore src/"),
        (wt, "git restore src/extra.py"),
        (wt, "git restore .git-pr-body.md"),
        (wt, "git restore src/app.py nowhere.py"),
        (sub, "git restore ."),
        (sub, "git restore ../src"),
        (sub, "git restore '*'"),
    ]:
        assert not worktree_restore_safe(command, cwd, False, project_dir=wt), (cwd, command)
