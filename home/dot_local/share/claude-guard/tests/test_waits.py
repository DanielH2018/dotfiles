"""The cc-wait binding: which calls are backgrounded, and which hand-written waits are denied.

Each session shape is a fake `ps` table, a pid mapped to (parent pid, command line), so the
wakeable decision is tested without the machine running the suite deciding it.
"""

import pytest

from claude_guard import waits

BRIDGE = (
    "/home/u/.local/share/claude/versions/2.1.289 --print --sdk-url https://x/sessions/s "
    "--session-id s --input-format stream-json --output-format stream-json"
)
FANOUT = "claude -p --model opus --permission-mode auto --output-format json"
INTERACTIVE = "claude --model opus"


def ps_for(claude_args: str | None):
    """A process tree: hook (300) under a shell (200) under `claude_args` (100), or no claude."""
    table = {300: (200, "python3 -m claude_guard.cli pre-tool-use"), 200: (100, "/bin/sh -c x")}
    table[100] = (1, claude_args) if claude_args else (1, "/sbin/init")
    return table.get


def call(command: str, **tool_input) -> dict:
    return {"tool_name": "Bash", "tool_input": {"command": command, **tool_input}}


@pytest.mark.parametrize("claude_args", [INTERACTIVE, BRIDGE])
def test_a_wait_in_a_wakeable_session_is_backgrounded(claude_args):
    updated = waits.rewrite(call("cc-wait land 3511", description="Wait"), 300, ps_for(claude_args))
    assert updated == {
        "command": "cc-wait land 3511 --budget 1740",
        "description": "Wait",
        "run_in_background": True,
        "timeout": waits.BACKGROUND_TIMEOUT_MS,
    }


@pytest.mark.parametrize("claude_args", [FANOUT, None])
def test_a_wait_that_nothing_can_wake_stays_in_the_foreground_under_the_limit(claude_args):
    updated = waits.rewrite(call("cc-wait land 3511"), 300, ps_for(claude_args))
    assert updated == {"command": "cc-wait land 3511", "timeout": waits.FOREGROUND_TIMEOUT_MS}


def test_a_subagent_s_wait_stays_in_the_foreground_even_in_a_wakeable_session():
    payload = {**call("cc-wait land 3511"), "agent_id": "a1", "agent_type": "general-purpose"}
    updated = waits.rewrite(payload, 300, ps_for(BRIDGE))
    assert "run_in_background" not in updated
    assert updated["timeout"] == waits.FOREGROUND_TIMEOUT_MS


def test_the_budget_goes_on_only_when_cc_wait_is_the_last_stage():
    chained = "./land.sh --pr 1 --detach && cc-wait land 1"
    assert waits.rewrite(call(chained), 300, ps_for(BRIDGE))["command"].endswith("--budget 1740")
    leading = "cc-wait land 1 && echo done"
    assert waits.rewrite(call(leading), 300, ps_for(BRIDGE))["command"] == leading


def test_a_call_that_is_not_a_wait_is_left_alone():
    assert waits.rewrite(call("echo cc-wait land 1"), 300, ps_for(BRIDGE)) is None
    assert waits.rewrite(call("ls"), 300, ps_for(BRIDGE)) is None


@pytest.mark.parametrize("claude_args", [BRIDGE, FANOUT])
def test_a_call_the_caller_already_backgrounded_gets_the_background_budget(claude_args):
    """Measured: a backgrounded `cc-wait land` kept the 570s budget and woke the session early."""
    payload = call("cc-wait land 1", run_in_background=True, timeout=120_000)
    assert waits.rewrite(payload, 300, ps_for(claude_args)) == {
        "command": "cc-wait land 1 --budget 1740",
        "run_in_background": True,
        "timeout": waits.BACKGROUND_TIMEOUT_MS,
    }


def test_a_backgrounded_call_that_already_has_its_budget_is_left_alone():
    payload = call(
        "cc-wait land 1 --budget 600", run_in_background=True, timeout=waits.BACKGROUND_TIMEOUT_MS
    )
    assert waits.rewrite(payload, 300, ps_for(BRIDGE)) is None


@pytest.mark.parametrize(
    "command",
    [
        "sleep 30",
        "systemctl restart x && sleep 15 && curl -s localhost",
        "sleep 1m",
        "until test -f /tmp/done; do sleep 5; done",
        "while ! curl -sf x; do sleep 2; done",
        "x && until curl -s y; do sleep 3; done && z",
        "while true; do curl -s x; sleep 5; done",
        "while true; do for h in a b; do ping -c1 $h; done; sleep 30; done",
        "timeout 1200 tail -f -n +1 land.log | grep -m1 '^VERDICT:'",
        "tail -F /var/log/syslog",
        "gh run watch 123",
        "gh pr checks 3511 --watch",
        "kubectl get pods -n media -w",
    ],
)
def test_a_hand_written_wait_in_the_foreground_is_denied_and_names_cc_wait_or_background(
    command,
):
    verdict = waits.hand_wait(command, background=False)
    assert verdict is not None and verdict.kind == "deny", command
    assert "cc-wait" in verdict.reason or "run_in_background" in verdict.reason


@pytest.mark.parametrize(
    "command",
    [
        "sleep 2",
        "tail -n 50 land.log",
        "gh pr checks 3511",
        "gh run view 123 --log-failed",
        "kubectl rollout status deploy/x",
        "echo 'sleep 30'",
        "git log --since='30 seconds ago'",
        # Measured: this search for leftover poll loops was denied as one.
        "git grep -n -e 'until [^;]*; do sleep' -- docs",
        'rg "while true; do sleep 1; done" docs',
        "cat <<'EOF' > loop.sh\nwhile true; do sleep 1; done\nEOF",
        "for f in a b; do sleep 30; done",
    ],
)
def test_a_command_that_is_not_a_hand_written_wait_passes(command):
    assert waits.hand_wait(command, background=False) is None


def test_the_same_wait_run_in_the_background_passes():
    assert waits.hand_wait("sleep 30", background=True) is None
    assert waits.hand_wait("gh run watch 123", background=True) is None


def test_listing_or_help_is_not_a_wait():
    """Measured: `cc-wait --list` in a chain was backgrounded, and its output came back late."""
    for command in ("cc-wait --list", "cc-wait --help", "cc-wait", "true && cc-wait --list"):
        assert waits.rewrite(call(command), 300, ps_for(BRIDGE)) is None, command
