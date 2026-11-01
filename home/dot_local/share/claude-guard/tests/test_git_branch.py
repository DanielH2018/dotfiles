"""Drives the checkout, switch and merge checks against a real clone, so ref resolution, the
remote-tracking guess and the path-ambiguity probe run real git."""

import subprocess

import pytest

from claude_guard.checks.git_branch import checkout_branch_safe, merge_safe
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots


def _sh(cwd, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


def _argv(command: str) -> list[str]:
    return command.split()


@pytest.fixture
def clone(tmp_path):
    """A clone of a repo with branches `feature`, `remote-only` and `notes`. The clone has a
    local `feature`, only a remote-tracking `remote-only`, and a file called `notes`."""
    origin = tmp_path / "origin"
    (origin / "src").mkdir(parents=True)
    _sh(origin, "git", "init", "-q", "-b", "main")
    _sh(origin, "git", "config", "user.email", "a@b.c")
    _sh(origin, "git", "config", "user.name", "a")
    (origin / "src" / "app.py").write_text("x = 1\n")
    (origin / "notes").write_text("n\n")
    _sh(origin, "git", "add", ".")
    _sh(origin, "git", "commit", "-q", "-m", "one")
    for branch in ("feature", "remote-only", "notes"):
        _sh(origin, "git", "branch", branch)
    clone = tmp_path / "clone"
    _sh(tmp_path, "git", "clone", "-q", str(origin), str(clone))
    _sh(clone, "git", "branch", "-q", "feature", "origin/feature")
    return str(clone)


def test_switching_to_an_existing_ref_or_creating_a_branch_is_allowed(clone):
    for command in [
        "git checkout feature",
        "git checkout -q feature",
        "git checkout --detach origin/main",
        "git checkout remote-only",
        "git checkout -",
        "git checkout -b fresh origin/feature",
        "git switch feature",
        "git switch -q remote-only",
        "git switch -c fresh",
        "git switch -c fresh origin/feature",
        "git switch -d origin/main",
    ]:
        assert checkout_branch_safe(_argv(command), clone, cwd_changed=False), command


def test_checkout_forms_that_discard_work_or_name_a_path_are_refused(clone):
    for command in [
        "git checkout -- src/app.py",
        "git checkout feature -- src/app.py",
        "git checkout .",
        "git checkout src/app.py",
        "git checkout notes",
        "git checkout missing",
        "git checkout -f feature",
        "git checkout --force feature",
        "git checkout -m feature",
        "git checkout -p feature",
        "git checkout --ours src/app.py",
        "git checkout --orphan fresh",
        "git checkout -B feature",
        "git checkout feature main",
        "git checkout -b bad..name",
        "git switch --discard-changes feature",
        "git switch -f feature",
        "git switch -C feature",
        "git switch",
    ]:
        assert not checkout_branch_safe(_argv(command), clone, cwd_changed=False), command


def test_merging_existing_refs_with_tabled_options_is_allowed(clone):
    for argv in [
        ["git", "merge", "origin/main"],
        ["git", "merge", "--no-edit", "origin/feature"],
        ["git", "merge", "-q", "--no-ff", "-m", "Merge origin/main into feature", "origin/main"],
        ["git", "merge", "--no-commit", "--no-ff", "origin/main"],
        ["git", "merge", "--message=pick up main", "origin/main", "feature"],
    ]:
        assert merge_safe(argv, clone, cwd_changed=False), argv


def test_strategy_options_hooks_skips_and_unresolved_refs_are_refused(clone):
    for command in [
        "git merge -s ours origin/main",
        "git merge --no-edit -s ours origin/main",
        "git merge --strategy=ours origin/main",
        "git merge -X theirs origin/main",
        "git merge --no-verify origin/main",
        "git merge --autostash origin/main",
        "git merge -F msg.txt origin/main",
        "git merge -e origin/main",
        "git merge --no-edit",
        "git merge missing",
        "git merge -m",
    ]:
        assert not merge_safe(_argv(command), clone, cwd_changed=False), command


def test_no_cwd_or_a_moved_cwd_gets_no_opinion(clone):
    for cwd, moved in [("", False), ("relative", False), (clone, True)]:
        assert not checkout_branch_safe(_argv("git checkout feature"), cwd, moved)
        assert not merge_safe(_argv("git merge origin/main"), cwd, moved)


def test_the_judge_grants_a_switch_then_merge_chain_and_refuses_discard_forms(clone, tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        '{"permissions": {"allow": ["Bash(tail:*)", "Bash(git status:*)"], "ask": ["Bash(rm:*)"]}}'
    )
    rules = load_rules(home=str(home), project_dir=None)
    roots = scratch_roots(str(home))
    command = "git checkout -q feature && git merge --no-edit origin/main 2>&1 | tail -3"
    d = judge(command, rules, roots, clone, clone)
    assert d.allow and {"git-checkout-check", "git-merge-check"} <= set(d.reasons), d
    for command in [
        "git switch --discard-changes feature",
        "git checkout -- src/app.py",
        "git merge -s ours origin/main",
        f"cd {tmp_path} && git checkout feature",
    ]:
        assert not judge(command, rules, roots, clone, clone).allow, command
