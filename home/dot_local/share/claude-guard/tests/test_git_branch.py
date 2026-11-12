"""Drives the checkout, switch, merge and rebase checks against a real clone, so ref
resolution, the remote-tracking guess, the path-ambiguity probe and the worktree-ownership
probes run real git."""

import os
import subprocess
import sys

import pytest

from claude_guard.checks.git_branch import checkout_branch_safe, merge_safe, rebase_safe
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


def test_no_cwd_a_moved_cwd_or_a_plain_repos_rebase_or_subagent_gets_no_opinion(clone):
    for cwd, moved in [("", False), ("relative", False), (clone, True)]:
        assert not checkout_branch_safe(_argv("git checkout feature"), cwd, moved)
        assert not merge_safe(_argv("git merge origin/main"), cwd, moved)
    # A plain repo has no owned worktree to rebase in, and a subagent there shares its
    # parent's checkout.
    assert not rebase_safe(_argv("git rebase origin/main"), clone, False, clone)
    assert not checkout_branch_safe(_argv("git checkout feature"), clone, False, clone, AGENT)


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


# Ownership reads the worktree lock's pid from /proc and matches the worktree by a POSIX path.
only_owned = pytest.mark.skipif(
    sys.platform == "win32" or not os.path.exists("/proc/self/stat"),
    reason="worktree ownership reads /proc and a POSIX `.claude/worktrees/` path",
)
AGENT = "a41336082886a72e3"


def _self_lock(kind: str, name: str) -> str:
    with open("/proc/self/stat") as fh:
        start = fh.read().rpartition(")")[2].split()[19]
    return f"claude {kind} {name} (pid {os.getpid()} start {start})"


@pytest.fixture
def shared(clone):
    """The clone as a repo several sessions share: (primary checkout, a session worktree
    this process's session lock holds, the isolation worktree of subagent AGENT, and a
    sibling worktree nobody here owns)."""
    trees = {}
    for name in ("session-1", f"agent-{AGENT}", "sibling"):
        path = os.path.join(clone, ".claude", "worktrees", name)
        _sh(clone, "git", "worktree", "add", "-q", "--detach", path, "origin/feature")
        trees[name] = path
    _sh(
        clone,
        "git",
        "worktree",
        "lock",
        "--reason",
        _self_lock("session", "session-1"),
        trees["session-1"],
    )
    _sh(
        clone,
        "git",
        "worktree",
        "lock",
        "--reason",
        _self_lock("agent", f"agent-{AGENT}"),
        trees[f"agent-{AGENT}"],
    )
    return clone, trees["session-1"], trees[f"agent-{AGENT}"], trees["sibling"]


@only_owned
def test_a_head_move_outside_the_callers_own_worktree_gets_no_opinion(shared):
    primary, session, agent_tree, sibling = shared
    for cwd, project_dir, agent_id in [
        (primary, primary, ""),  # the primary checkout every session reads
        (sibling, primary, ""),  # another session's worktree
        (agent_tree, primary, ""),  # the main session in its subagent's worktree
        (agent_tree, primary, "a0000000000000000"),  # a sibling subagent
        (session, primary, AGENT),  # a subagent in its parent's worktree
        (primary, primary, AGENT),  # a subagent in the primary checkout
    ]:
        checkout = ["git", "checkout", "feature"]
        assert not checkout_branch_safe(checkout, cwd, False, project_dir, agent_id), cwd
        assert not merge_safe(["git", "merge", "origin/main"], cwd, False, project_dir, agent_id)


@only_owned
def test_in_its_own_worktree_a_caller_may_reset_a_branch_and_rebase(shared):
    primary, session, agent_tree, _ = shared
    for cwd, project_dir, agent_id in [
        (session, primary, ""),  # an EnterWorktree session, owned through its lock
        (session, session, ""),  # a fan-out batch launched in its worktree
        (agent_tree, primary, AGENT),  # the PR 8004 fix agent in its isolation worktree
    ]:
        for command in [
            "git checkout -B local-8004 origin/feature",
            "git switch -C local-8004 origin/feature",
        ]:
            assert checkout_branch_safe(command.split(), cwd, False, project_dir, agent_id), command
        assert merge_safe(["git", "merge", "origin/main"], cwd, False, project_dir, agent_id)
        for command in [
            "git rebase origin/main",
            "git rebase --onto origin/main feature HEAD",
            "git rebase --continue",
            "git rebase --abort",
        ]:
            assert rebase_safe(command.split(), cwd, False, project_dir, agent_id), command


@only_owned
def test_rebase_forms_that_run_code_drop_commits_or_name_no_ref_are_refused(shared):
    primary, session, _, _ = shared
    for command in [
        "git rebase -i origin/main",
        "git rebase --exec make origin/main",
        "git rebase -X theirs origin/main",
        "git rebase --root",
        "git rebase --skip",
        "git rebase --onto origin/main",
        "git rebase missing",
        "git rebase origin/main feature extra",
        "git rebase",
    ]:
        assert not rebase_safe(command.split(), session, False, primary), command


@only_owned
def test_the_judge_grants_the_pr_8004_command_only_to_the_agent_that_owns_the_tree(
    shared, tmp_path
):
    primary, _, agent_tree, _ = shared
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        '{"permissions": {"allow": ["Bash(tail:*)", "Bash(pwd)"], "ask": []}}'
    )
    rules = load_rules(home=str(home), project_dir=None)
    roots = scratch_roots(str(home))
    command = (
        "pwd; git checkout -B local-8004 origin/feature 2>&1 | tail -2; "
        "git rebase origin/main 2>&1 | tail -5"
    )
    d = judge(command, rules, roots, agent_tree, primary, "", AGENT)
    assert d.allow and {"git-checkout-check", "git-rebase-check"} <= set(d.reasons), d
    assert not judge(command, rules, roots, agent_tree, primary, "", "a0000000000000000").allow
    assert not judge(command, rules, roots, primary, primary, "", AGENT).allow
    # A command that can rewrite the lock first gets none of the ownership grants.
    assert not judge(
        f"git worktree unlock {agent_tree}; git checkout -B x origin/feature",
        rules,
        roots,
        agent_tree,
        primary,
        "",
        AGENT,
    ).allow
