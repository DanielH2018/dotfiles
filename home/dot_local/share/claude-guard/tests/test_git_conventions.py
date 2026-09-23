"""claude_guard.checks.git_conventions: each rule as an _is_flagged / _is_clean pair (#575)."""

import json

import pytest

from claude_guard.checks.git_conventions import hook_output, verdict


def kind(command: str) -> str | None:
    v = verdict(command)
    return v[0] if v else None


@pytest.mark.parametrize(
    "command",
    [
        "git commit --amend --no-edit",
        "git commit -a --amend",
        "git -C /tmp/repo commit --amend -m 'x'",
        "git commit --am",  # git accepts an unambiguous prefix of a long option
        "ls && git commit --amend",
        "echo $(git commit --amend)",
    ],
)
def test_amend_is_flagged(command):
    assert kind(command) == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "git commit -m 'Fix the thing'",
        'git commit -m "never git commit --amend"',
        "git commit -am '--amend'",
        "git log --format=%s | grep amend",
        "git commit --fixup=amend:HEAD~1",
    ],
)
def test_amend_is_clean(command):
    assert kind(command) is None


@pytest.mark.parametrize(
    "command",
    [
        "git merge topic",
        "git merge --no-ff topic",
        "git -C ~/repo merge origin/main",
        "git -c merge.ff=false merge topic",
    ],
)
def test_merge_is_flagged(command):
    assert kind(command) == "ask"


@pytest.mark.parametrize(
    "command",
    [
        # The shapes bin/land-sync runs, typed by hand.
        "git merge --ff-only origin/main",
        "git -C /home/u/.local/share/chezmoi merge --ff-only origin/main",
        "git merge-base --is-ancestor HEAD origin/main",
        "git merge --abort",
        "git merge --continue",
        "echo 'git merge topic'",
    ],
)
def test_merge_is_clean(command):
    assert kind(command) is None


@pytest.mark.parametrize(
    "command",
    [
        'gh pr create --title "feat: x" --body y',
        'gh pr create --title "fix(hooks): stop the loop"',
        'gh pr create --title "feat!: break it"',
        "gh pr create --title=chore:bump",
        'gh pr edit 12 -t "PAY-1234 Fix settlement retries"',
        'gh pr create -t"docs: readme"',
        'gh pr create --draft --title "Fix the race (ABC-12)"',
    ],
)
def test_pr_title_is_flagged(command):
    assert kind(command) == "deny"


@pytest.mark.parametrize(
    "command",
    [
        'gh pr create --title "Pin the runner image"',
        'gh pr create --title "Fix race condition in settlement processor on concurrent retries"',
        'gh pr create --title "Bump the SHA-256 pin"',
        'gh pr edit 3 --title "Decode UTF-8 paths and patch CVE-2024-1234"',
        "gh pr create --fill",
        'gh issue create --title "feat: x"',
    ],
)
def test_pr_title_is_clean(command):
    assert kind(command) is None


def test_a_deny_wins_over_an_ask_in_one_command():
    assert kind('git merge topic && gh pr create --title "feat: x"') == "deny"


def test_an_unreadable_command_is_no_decision():
    assert verdict("git commit --amend 'unbalanced") is None


def test_hook_output_is_pre_tool_use_json():
    out = json.loads(hook_output(json.dumps({"tool_input": {"command": "git merge topic"}})))
    assert out["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert out["hookSpecificOutput"]["permissionDecision"] == "ask"
    assert hook_output("not json") is None
