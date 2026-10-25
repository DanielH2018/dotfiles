"""Drives the worktree cleanup checks against a real `git worktree add` under
`.claude/worktrees/`, so the tracked-file probe and the toplevel test run real git."""

import os
import subprocess
import sys

import pytest

from claude_guard.checks.worktree_scratch import worktree_restore_safe, worktree_rm_safe
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots

# worktree_scratch matches the `/.claude/worktrees/<name>` toplevel with a `/`-separated regex
# over os.path.realpath output, which is backslash-separated on Windows. No Windows form of the
# session-worktree test is defined, and `rm`/`git clean` are destructive, so on Windows the
# check gives no opinion and an ALLOW assertion cannot hold. Refusal assertions run everywhere;
# only the allow assertions sit behind this flag.
ALLOW_OK = sys.platform != "win32"
only_posix_allow = pytest.mark.skipif(
    not ALLOW_OK, reason="worktree_scratch recognises session worktrees by a POSIX path shape only"
)


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


@only_posix_allow
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
    if ALLOW_OK:
        assert worktree_rm_safe(f"rm {wt}/.git-pr-body.md", wt, cwd_changed=True, project_dir=wt)
    assert not worktree_restore_safe("git restore src/app.py", wt, cwd_changed=True, project_dir=wt)


@only_posix_allow
def test_git_restore_of_tracked_files_to_head_is_allowed(repo):
    _, wt = repo
    for command in [
        "git restore src/app.py",
        "git restore --staged --worktree src/app.py",
        "git restore --source=HEAD --staged --worktree src/app.py",
        "git restore -SW --source=HEAD src/app.py",
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
        "git restore -Sp src/app.py",
        "git restore ':(glob)src/*'",
        f"git restore {main}/src/app.py",
        "git restore .",
    ]:
        assert not worktree_restore_safe(command, wt, cwd_changed=False, project_dir=wt), command


@only_posix_allow
def test_git_restore_brings_back_a_file_whose_deletion_is_staged(repo):
    _, wt = repo
    _sh(wt, "git", "rm", "-qf", "src/app.py")
    command = "git restore --staged --worktree --source=HEAD src/app.py"
    assert worktree_restore_safe(command, wt, cwd_changed=False, project_dir=wt)
    assert not worktree_restore_safe("git restore --staged src", wt, False, wt)


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
    if ALLOW_OK:
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
    if ALLOW_OK:
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
        if ALLOW_OK:
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
    if ALLOW_OK:
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


def _ask_rules(tmp_path, allow=()):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    allowed = ", ".join(f'"{rule}"' for rule in ("Bash(cd:*)", "Bash(true)", "Bash(ls:*)", *allow))
    (home / ".claude" / "settings.json").write_text(
        f'{{"permissions": {{"allow": [{allowed}],'
        ' "ask": ["Bash(rm:*)", "Bash(git clean:*)", "Bash(git restore:*)",'
        ' "Bash(git stash drop:*)", "Bash(git stash clear)"]}}'
    )
    return load_rules(home=str(home), project_dir=None), scratch_roots(str(home))


@only_posix_allow
def test_git_clean_of_untracked_scratch_in_a_session_worktree_is_allowed(repo, tmp_path):
    _, wt = repo
    rules, roots = _ask_rules(tmp_path)
    for command in [
        "git clean -f -- .git-pr-body.md",
        "git clean -fdq -- scratch",
        "git clean -f .git-pr-body.md scratch/probe.py",
        f"git clean --force -- {wt}/scratch",
    ]:
        assert judge(command, rules, roots, wt, wt).allow, command


def test_git_clean_of_the_whole_tree_tracked_or_ignored_paths_is_refused(repo, tmp_path):
    main, wt = repo
    rules, roots = _ask_rules(tmp_path)
    with open(os.path.join(wt, ".env"), "w") as f:
        f.write("A=1\n")
    for command in [
        "git clean -f",
        "git clean -fd",
        "git clean -fx -- scratch",
        "git clean -fX -- scratch",
        "git clean -ff -- scratch",
        "git clean -f -e x -- scratch",
        "git clean -fi -- scratch",
        "git clean -f -- src/app.py",
        "git clean -f -- .env",
        "git clean -f -- 'scratch/*'",
        "git clean -f -- ':(glob)scratch/*'",
        f"git clean -f -- {main}/src",
    ]:
        assert not judge(command, rules, roots, wt, wt).allow, command
    assert not judge("git clean -f -- .git-pr-body.md", rules, roots, main, main).allow


def test_a_cd_to_the_sessions_own_cwd_leaves_relative_cleanup_allowed(repo, tmp_path):
    main, wt = repo
    rules, roots = _ask_rules(tmp_path)
    if ALLOW_OK:
        assert judge(f"cd {wt} && rm .git-pr-body.md", rules, roots, wt, wt).allow
        assert judge(f"cd {wt}/ && git clean -f -- scratch", rules, roots, wt, wt).allow
    for command in [
        f"cd {main} && rm .git-pr-body.md",
        f"cd {wt}/scratch && rm probe.py",
        "cd - && rm .git-pr-body.md",
        f"cd -P {wt} && rm .git-pr-body.md",
        f"timeout 5 cd {wt} && rm .git-pr-body.md",
        f"pushd {wt} && rm .git-pr-body.md",
    ]:
        assert not judge(command, rules, roots, wt, wt).allow, command


@only_posix_allow
def test_a_cd_to_the_worktree_root_from_elsewhere_allows_relative_cleanup(repo, tmp_path):
    _, wt = repo
    rules, roots = _ask_rules(tmp_path)
    sub = os.path.join(wt, "src")
    for command in [
        f"cd {wt} && rm .git-pr-body.md",
        f"cd {wt} && git restore --staged --worktree --source=HEAD src/app.py",
    ]:
        assert judge(command, rules, roots, sub, wt).allow, command
        assert judge(command, rules, roots, "", wt).allow, command


def test_cleanup_after_a_cd_to_the_worktree_root_needs_an_unbroken_and_run(repo, tmp_path):
    main, wt = repo
    rules, roots = _ask_rules(tmp_path)
    sub = os.path.join(wt, "src")
    for command in [
        f"cd {wt}; rm .git-pr-body.md",
        f"cd {wt} || rm .git-pr-body.md",
        f"cd {wt} && rm -r scratch; rm .git-pr-body.md",
        f"true || cd {wt} && rm .git-pr-body.md",
        f"ls | cd {wt} && rm .git-pr-body.md",
        f"cd {wt}/src/.. && rm .git-pr-body.md",
        f"cd {main}/.claude/worktrees/fanout-1/scratch && rm probe.py",
    ]:
        assert not judge(command, rules, roots, sub, wt).allow, command
        assert not judge(command, rules, roots, "", wt).allow, command
    assert not judge(f"cd {wt} && rm .git-pr-body.md", rules, roots, sub, main).allow


def test_a_cd_whose_words_tokenize_refuses_is_refused_rather_than_raising(repo, tmp_path):
    _, wt = repo
    rules, roots = _ask_rules(tmp_path)
    for command in [
        "cd ~ && rm .git-pr-body.md",
        'cd "$HOME" && rm .git-pr-body.md',
        "cd /tmp 2>/dev/null && rm .git-pr-body.md",
    ]:
        assert not judge(command, rules, roots, wt, wt).allow, command


def _stashes(main: str, wt: str) -> None:
    """Pushes one stash entry from the session worktree's branch, then one from the primary
    checkout's, so `stash@{0}` is the primary's and `stash@{1}` the session's."""
    _sh(wt, "git", "stash", "push", "-q", "-m", "mine", "--", "src/app.py")
    with open(os.path.join(main, "src", "app.py"), "w") as f:
        f.write("x = 3\n")
    _sh(main, "git", "stash", "push", "-q")


def _stash_subjects(main: str) -> list[str]:
    out = subprocess.run(
        ["git", "stash", "list", "--format=%s"], cwd=main, capture_output=True, text=True
    )
    return out.stdout.splitlines()


@only_posix_allow
def test_a_drop_of_a_stash_entry_made_on_the_sessions_branch_is_allowed(repo, tmp_path):
    main, wt = repo
    rules, roots = _ask_rules(tmp_path)
    _stashes(main, wt)
    for command in [
        "git stash drop stash@{1}",
        "git stash drop -q 'stash@{1}'",
        f"git -C {wt} stash drop --quiet stash@{{1}}",
    ]:
        assert judge(command, rules, roots, wt, wt).allow, command
    command = f"cd {wt} && git stash drop -q stash@{{1}}"
    assert judge(command, rules, roots, "", wt).allow
    # The granted drop removes the session's entry and leaves the primary checkout's.
    subprocess.run(command, shell=True, check=True, capture_output=True)
    left = _stash_subjects(main)
    assert len(left) == 1 and left[0].startswith("WIP on ") and "fanout-1" not in left[0]


def test_a_drop_of_another_branchs_entry_or_of_no_one_entry_is_refused(repo, tmp_path):
    main, wt = repo
    rules, roots = _ask_rules(tmp_path)
    _stashes(main, wt)
    for command in [
        "git stash drop stash@{0}",
        "git stash drop",
        "git stash drop -q",
        "git stash clear",
        "git stash drop stash@{2}",
        "git stash drop stash@{01}",
        "git stash drop stash@{1}.",
        "git stash drop stash@{1} stash@{1}",
    ]:
        assert not judge(command, rules, roots, wt, wt).allow, command
    assert not judge("git stash drop stash@{1}", rules, roots, main, main).allow
    assert not judge("git stash drop stash@{1}", rules, roots, wt, main).allow
    assert not judge(f"cd {main} && git stash drop stash@{{1}}", rules, roots, wt, wt).allow


def test_a_drop_is_refused_when_the_command_can_change_the_stack_first(repo, tmp_path):
    main, wt = repo
    # The deployed settings allow these two, so a push or list before the drop can run (#1030).
    rules, roots = _ask_rules(tmp_path, ("Bash(git stash push -u -m:*)", "Bash(git stash list:*)"))
    _stashes(main, wt)
    for command in [
        "git stash drop stash@{1}; git stash drop stash@{1}",
        "git stash drop stash@{1} && git stash drop stash@{1}",
        "git stash push -u -m new && git stash drop stash@{1}",
        "git stash list && git stash drop stash@{1}",
    ]:
        d = judge(command, rules, roots, wt, wt)
        assert not d.allow and d.reasons[-1] == "worktree-stash-drop:stack-changes", command
    for command in [
        "for i in 1 2; do git stash drop stash@{1}; done",
        "while true; do git stash drop stash@{1}; done",
    ]:
        assert not judge(command, rules, roots, wt, wt).allow, command
