"""A hand-run homelab write asks outside auto mode (dotfiles #1321, #1326).

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
BOOTSTRAPS = [
    "hosts/bootstrap-host.sh daniel-pi",
    "./hosts/bootstrap-host.sh daniel-pi --until 3",
    "cd /repo && bash hosts/bootstrap-host.sh daniel-pi",
    "nohup sh -x /tmp/bootstrap-host.sh daniel-pi",
    "ssh daniel-pi 'sh /tmp/bootstrap-host.sh daniel-pi'",
    "bash -c 'hosts/bootstrap-host.sh daniel-pi'",
]
# No sudo form: the sudo boundary in deny.py already denies it, locally and over ssh.
RECONCILES = [
    "systemctl start homelab-reconcile",
    "systemctl restart homelab-reconcile.service",
    "systemctl enable --now homelab-reconcile",
    "ssh root@daniel-server systemctl start homelab-reconcile",
    "ssh -o BatchMode=yes -p 22 daniel-pi 'cd /; systemctl start --no-block homelab-reconcile'",
    "hl systemctl start homelab-reconcile.service",
    "timeout 30 ssh daniel-pi systemctl try-restart homelab-reconcile",
]
WRITES = DISPATCHES + BOOTSTRAPS + RECONCILES
NOT_WRITES = [
    "gh workflow view promote.yml",
    "gh workflow run ci.yml -f ref=promote.yml",
    "gh run list --workflow promote.yml",
    "echo gh workflow run promote.yml",
    "shellcheck hosts/bootstrap-host.sh",
    "bash -n hosts/bootstrap-host.sh",
    "git log -- hosts/bootstrap-host.sh",
    "ssh daniel-server systemctl status homelab-reconcile",
    "ssh daniel-server journalctl -u homelab-reconcile",
    "systemctl enable homelab-reconcile.timer",
    "systemctl start other.service",
]
# Payloads to a trusted ssh host, which the judge's trusted-host arm would otherwise allow.
TRUSTED_HOST_WRITES = [
    "ssh daniel-server systemctl start homelab-reconcile",
    "ssh daniel-pi hosts/bootstrap-host.sh daniel-pi",
    "ssh daniel-server gh workflow run promote.yml",
]


@pytest.fixture
def env(tmp_path, template_permissions):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    settings = {"permissions": template_permissions}
    (home / ".claude" / "settings.json").write_text(json.dumps(settings))
    return {"HOME": str(home), "PATH": "/usr/bin:/bin"}


def hook_output(command: str, env: dict, mode: str | None) -> dict:
    payload: dict = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "/repo"}
    if mode:
        payload["permission_mode"] = mode
    out = pre_tool_use(json.dumps(payload), env)
    return json.loads(out)["hookSpecificOutput"] if out else {}


def decision(command: str, env: dict, mode: str | None) -> str:
    return hook_output(command, env, mode).get("permissionDecision", "none")


@pytest.mark.parametrize("mode", ["default", "acceptEdits"])
@pytest.mark.parametrize("command", WRITES)
def test_a_homelab_write_asks_in_a_prompting_mode(env, mode, command):
    assert decision(command, env, mode) == "ask"


@pytest.mark.parametrize(
    ("command", "word"),
    [
        (DISPATCHES[0], "promote"),
        (BOOTSTRAPS[0], "bootstrap-host.sh"),
        (RECONCILES[0], "homelab-reconcile"),
    ],
)
def test_the_ask_names_the_route(env, command, word):
    assert word in hook_output(command, env, "default")["permissionDecisionReason"]


@pytest.mark.parametrize("mode", ["auto", "bypassPermissions", None])
@pytest.mark.parametrize("command", [DISPATCHES[1], BOOTSTRAPS[0], RECONCILES[3]])
def test_a_homelab_write_is_left_to_auto_mode_and_a_missing_mode(env, mode, command):
    assert decision(command, env, mode) == "none"


@pytest.mark.parametrize("command", NOT_WRITES)
def test_a_read_or_another_unit_does_not_ask(env, command):
    assert decision(command, env, "default") == "none"


@pytest.mark.parametrize("command", DISPATCHES[:2] + TRUSTED_HOST_WRITES)
def test_the_permission_request_judge_does_not_allow_a_homelab_write(env, command):
    """A judge allow would answer the prompt this check raises."""
    assert not decide(command, "/repo", env).allow


def test_the_judge_still_allows_another_trusted_host_payload(env):
    assert decide("ssh daniel-server systemctl restart other", "/repo", env).allow
