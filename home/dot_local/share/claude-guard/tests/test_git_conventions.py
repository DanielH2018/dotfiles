"""claude_guard.checks.git_conventions: each rule as an _is_flagged / _is_clean pair (#575,
#607, #608).

Every case runs through `cli pre-tool-use`, the entry the PreToolUse shim calls (#619). A test
of `verdict()` alone would stay green if the hook stopped calling it, or called it inside the
deny side's fail-closed ask, which is the DECIDED posture the module docstring pins.
"""

import contextlib
import io
import json
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

from claude_guard import cli, hook
from claude_guard.checks import git_conventions
from claude_guard.hook import ASK_JSON

CWD = "/home/u/repo"


def run_hook(command: str, cwd: str = CWD) -> dict | None:
    old_stdin = sys.stdin
    sys.stdin = io.StringIO(json.dumps({"tool_input": {"command": command}, "cwd": cwd}))
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            assert cli.main(["pre-tool-use"]) == 0
    finally:
        sys.stdin = old_stdin
    return json.loads(out.getvalue())["hookSpecificOutput"] if out.getvalue().strip() else None


def kind(command: str) -> str | None:
    d = run_hook(command)
    return d["permissionDecision"] if d else None


@pytest.fixture
def config(tmp_path, monkeypatch):
    """The git config a pull reads (`values`), and each directory it was read in (`seen`).
    Empty by default, so a bare pull asks; nothing here shells out to git."""
    monkeypatch.setenv("HOME", str(tmp_path))
    state = SimpleNamespace(values={}, seen=[])

    def fake(directory, keys):
        state.seen.append(directory)
        return {k: v for k, v in state.values.items() if k in keys}

    monkeypatch.setattr(git_conventions, "read_git_config", fake)
    return state


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
def test_amend_is_flagged(config, command):
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
def test_amend_is_clean(config, command):
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
def test_merge_is_flagged(config, command):
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
def test_merge_is_clean(config, command):
    assert kind(command) is None


# --- git pull (#607) -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "command",
    [
        "git pull",
        "git pull origin main",
        "git -C ~/repo pull",
        "git pull --no-rebase",
        "git pull --rebase=false",
        "git pull --rebase --no-rebase",  # the last of a pair wins, as in git
        "git pull --ff-only --ff",
        "git -c pull.rebase=false pull",
    ],
)
def test_pull_is_flagged(config, command):
    assert kind(command) == "ask"


@pytest.mark.parametrize(
    "command",
    [
        "git pull --ff-only",
        "git pull --rebase",
        "git pull -r origin main",
        "git pull -qr",
        "git pull --rebase=merges",
        "git pull -X theirs --rebase",
        "git -c pull.rebase=true pull",
        "git -c pull.ff=only pull",
        "echo 'git pull'",
    ],
)
def test_pull_is_clean(config, command):
    assert kind(command) is None


@pytest.mark.parametrize(
    "values",
    [{"pull.rebase": "true"}, {"pull.rebase": "merges"}, {"pull.ff": "only"}],
)
def test_pull_is_clean_when_config_rebases_or_fast_forwards_only(config, values):
    config.values.update(values)
    assert kind("git pull") is None


@pytest.mark.parametrize(
    ("values", "command"),
    [
        ({"pull.rebase": "false"}, "git pull"),
        ({"pull.ff": "true"}, "git pull"),
        ({"pull.rebase": "true"}, "git pull --no-rebase"),  # the flag beats the config
        ({"pull.ff": "only"}, "git pull --no-ff"),
        ({"pull.rebase": "true"}, "git -c pull.rebase=false pull"),  # -c beats the file
    ],
)
def test_pull_is_flagged_when_config_or_a_flag_leaves_a_merge_possible(config, values, command):
    config.values.update(values)
    assert kind(command) == "ask"


def test_pull_reads_config_in_the_session_cwd_moved_by_dash_c(config):
    kind("git -C sub pull")
    kind("git status && git merge --ff-only origin/main")  # no pull: no config read
    assert config.seen == [os.path.join(CWD, "sub")]


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def test_pull_reads_the_real_repo_config(tmp_path, monkeypatch):
    # Hermetic: no GIT_DIR from a hook run (git -C does not override it), and no user config.
    for var in [v for v in os.environ if v.startswith("GIT_")]:
        monkeypatch.delenv(var)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("HOME", str(tmp_path))
    repo = tmp_path / "repo"
    _git(tmp_path, "init", "-q", str(repo))
    assert run_hook("git pull", str(repo))["permissionDecision"] == "ask"
    _git(repo, "config", "pull.rebase", "true")
    assert run_hook("git pull", str(repo)) is None


# --- titles: gh pr (#575) and planka cards (#608) ------------------------------------------------


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
def test_pr_title_is_flagged(config, command):
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
def test_pr_title_is_clean(config, command):
    assert kind(command) is None


@pytest.mark.parametrize(
    "command",
    [
        'planka card field --set title="feat: stop the retry"',
        'planka card field --set="title=PAY-12 Stop the retry"',
        'planka card field --set branch=x --set title="fix(api): stop the retry"',
        'planka card resolve --create --title "chore: bump"',
        'planka --strict card resolve --create --title="Fix the race (ABC-12)"',
    ],
)
def test_planka_title_is_flagged(config, command):
    d = run_hook(command)
    assert d["permissionDecision"] == "deny"
    assert "Planka card title" in d["permissionDecisionReason"]


@pytest.mark.parametrize(
    "command",
    [
        'planka card field --set title="Stop the settlement retry from double-posting"',
        'planka card field --set title="Bump the SHA-256 pin for CVE-2024-1234"',
        'planka card field --set repo="feat: x"',  # not the title key
        'planka card comment --text "feat: x"',
        "planka card resolve --create",
    ],
)
def test_planka_title_is_clean(config, command):
    assert kind(command) is None


# --- how the conventions combine with the deny rules (#619) --------------------------------------


def test_a_deny_wins_over_an_ask_in_one_command(config):
    assert kind('git merge topic && gh pr create --title "feat: x"') == "deny"


def test_a_deny_rule_wins_over_a_convention_ask(config):
    d = run_hook("git merge topic && rm -rf /")
    assert d["permissionDecision"] == "deny"
    assert not d["permissionDecisionReason"].startswith("git-conventions")


def test_a_convention_ask_over_the_force_upgrade_keeps_the_upgraded_command(config):
    d = run_hook("git push --force origin topic && git merge topic")
    assert d["permissionDecision"] == "ask"
    assert "--force-with-lease origin topic" in d["updatedInput"]["command"]


def test_the_force_upgrade_alone_is_still_an_allow(config):
    assert kind("git push --force origin topic") == "allow"


def test_an_unreadable_command_is_no_decision(config):
    assert run_hook("git commit --amend 'unbalanced") is None


def test_a_failing_convention_check_is_no_decision(config, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(git_conventions, "verdict", boom)
    assert run_hook("git commit --amend") is None


def test_a_failing_deny_rule_is_still_the_fail_closed_ask(config, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(hook, "deny", boom)
    assert run_hook("git commit -m 'x'") == json.loads(ASK_JSON)["hookSpecificOutput"]
