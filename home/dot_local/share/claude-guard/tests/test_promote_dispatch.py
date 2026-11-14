"""A hand dispatch of `promote` asks outside auto mode (dotfiles #1321).

Driven through `hook.pre_tool_use` with a temp HOME whose settings hold the template's
permissions, as the harness sends a payload carrying `permission_mode`.
"""

import json

import pytest

from claude_guard.hook import decide, pre_tool_use

DISPATCHES = [
    "gh workflow run promote.yml -f sha=abc123",
    "gh workflow run -R DanielH2018/server promote.yml -f sha=abc123",
    "gh workflow run --repo=DanielH2018/server promote.yml -f sha=abc123",
    "gh workflow -R DanielH2018/server run promote -f sha=abc123",
    "gh workflow run -r master -F sha=abc123 .github/workflows/promote.yaml",
    "cd /repo && gh workflow run promote.yml -f sha=abc123",
    "env GH_REPO=DanielH2018/server gh workflow run promote.yml",
    "timeout 60 gh workflow run promote.yml -f sha=abc123",
    "nohup nice -n 5 gh workflow run promote.yml",
    "time gh workflow run promote.yml",
    "xargs gh workflow run promote.yml < /dev/null",
]
NOT_DISPATCHES = [
    "gh workflow view promote.yml",
    "gh workflow run ci.yml -f ref=promote.yml",
    "gh run list --workflow promote.yml",
    "echo gh workflow run promote.yml",
]


@pytest.fixture
def env(tmp_path, template_permissions):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    settings = {"permissions": template_permissions}
    (home / ".claude" / "settings.json").write_text(json.dumps(settings))
    return {"HOME": str(home), "PATH": "/usr/bin:/bin"}


def decision(command: str, env: dict, mode: str | None) -> str:
    payload: dict = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "/repo"}
    if mode:
        payload["permission_mode"] = mode
    out = pre_tool_use(json.dumps(payload), env)
    if out is None:
        return "none"
    return json.loads(out)["hookSpecificOutput"].get("permissionDecision", "none")


@pytest.mark.parametrize("mode", ["default", "acceptEdits"])
@pytest.mark.parametrize("command", DISPATCHES)
def test_a_promote_dispatch_asks_in_a_prompting_mode(env, mode, command):
    assert decision(command, env, mode) == "ask"


@pytest.mark.parametrize("mode", ["auto", "bypassPermissions", None])
def test_a_promote_dispatch_is_left_to_auto_mode_and_a_missing_mode(env, mode):
    assert decision(DISPATCHES[1], env, mode) == "none"


@pytest.mark.parametrize("command", NOT_DISPATCHES)
def test_another_workflow_or_a_read_does_not_ask(env, command):
    assert decision(command, env, "default") == "none"


def test_the_permission_request_judge_does_not_allow_a_dispatch(env):
    """A judge allow would answer the prompt this check raises."""
    for command in DISPATCHES[:2]:
        assert not decide(command, "/repo", env).allow, command
