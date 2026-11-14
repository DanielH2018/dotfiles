"""A hand-run homelab write asks outside auto mode.

Dotfiles #1321, #1326, #1334, #1342, #1346, #1347, #1354 and #1355.

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
    "bash -lc 'hosts/bootstrap-host.sh daniel-pi'",
    "bash -e -o pipefail hosts/bootstrap-host.sh daniel-pi",
    "bash 2>/dev/null hosts/bootstrap-host.sh daniel-pi",
    "ssh daniel-pi bash -s < hosts/bootstrap-host.sh",
    "ssh daniel-pi bash -s -- daniel-pi < hosts/bootstrap-host.sh",
    "ssh daniel-pi < hosts/bootstrap-host.sh",
    "< hosts/bootstrap-host.sh bash",
    "cat hosts/bootstrap-host.sh | ssh daniel-pi sh",
    "cat hosts/bootstrap-host.sh |& ssh daniel-pi sh",
    "echo $(ssh daniel-pi bash -s < hosts/bootstrap-host.sh)",
    "x=$(cat hosts/bootstrap-host.sh | ssh daniel-pi sh)",
    "sed '' hosts/bootstrap-host.sh | ssh daniel-pi sh",
    "tee /tmp/copy.sh < hosts/bootstrap-host.sh | ssh daniel-pi bash -s",
    "cat hosts/bootstrap-host.sh | head -n 500 | ssh daniel-pi sh",
    "head -n 500 < hosts/bootstrap-host.sh | ssh daniel-pi sh",
    "ssh daniel-pi bash -s 1 < hosts/bootstrap-host.sh",
    "ssh daniel-pi bash -s < hosts/bootstrap-host.sh 3< /dev/null",
    "cat hosts/bootstrap-host.sh | ssh daniel-pi bash 3< /dev/null",
    "bash <(cat hosts/bootstrap-host.sh) daniel-pi",
    "bash < <(sed '' hosts/bootstrap-host.sh)",
    "ssh daniel-pi 'bash <(cat hosts/bootstrap-host.sh)'",
    "tee >(ssh daniel-pi sh) < hosts/bootstrap-host.sh",
    "cat hosts/bootstrap-host.sh > >(sh)",
    "cat hosts/bootstrap-host.sh | tee >(true; sh) > /dev/null",
    "dd if=hosts/bootstrap-host.sh of=>(sh)",
    "source hosts/bootstrap-host.sh",
    ". hosts/bootstrap-host.sh daniel-pi",
    "source <(cat hosts/bootstrap-host.sh)",
    "bash -c 'sh' < hosts/bootstrap-host.sh",
    "ssh daniel-pi 'cd /srv && sh' < hosts/bootstrap-host.sh",
    'eval "$(cat hosts/bootstrap-host.sh)"',
    "eval `cat hosts/bootstrap-host.sh`",
    'echo "$(cat hosts/bootstrap-host.sh)" | ssh daniel-pi sh',
    'script=$(cat hosts/bootstrap-host.sh); eval "$script"',
    'script=hosts/bootstrap-host.sh; bash "$script" daniel-pi',
    "export script=hosts/bootstrap-host.sh && ssh daniel-pi sh < ${script}",
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
    "ssh daniel-pi -- systemctl start homelab-reconcile",
    "ssh daniel-pi -t 'systemctl start homelab-reconcile'",
    "ssh daniel-pi sh <<'EOF'\nsystemctl start homelab-reconcile\nEOF",
    "cat <<'EOF' | ssh daniel-pi bash\nsystemctl start homelab-reconcile\nEOF",
    "bash <<< 'systemctl start homelab-reconcile'",
    "sed 's/^ //' <<'EOF' | ssh daniel-pi bash\n systemctl start homelab-reconcile\nEOF",
    "bash <(cat <<'EOF'\nsystemctl start homelab-reconcile\nEOF\n)",
    "echo 'systemctl start homelab-reconcile' | ssh daniel-pi sh",
    "echo -e 'cd /\\nsystemctl start homelab-reconcile' | ssh daniel-pi sh",
    "printf '%s\\n' 'systemctl start homelab-reconcile' | ssh daniel-pi sh",
    "printf '%s\\n' 'cd /' 'systemctl start homelab-reconcile' | ssh daniel-pi sh",
    "printf '%s %s %s\\n' systemctl start homelab-reconcile | ssh daniel-pi sh",
    "printf 'systemctl start %s\\n' homelab-reconcile | ssh daniel-pi bash",
    "printf 'systemctl start homelab-%s\\n' reconcile | ssh daniel-pi sh",
    "printf 'systemctl %s homelab-reconcile\\n' start | ssh daniel-pi sh",
    "bash <(echo systemctl start homelab-reconcile)",
    "dd if=/dev/zero of=>(systemctl start homelab-reconcile)",
    "foo --out=>(ssh daniel-pi systemctl start homelab-reconcile)",
    "echo 'systemctl start homelab-reconcile' > >(ssh daniel-pi sh)",
    "bash -c 'sh' <<< 'systemctl start homelab-reconcile'",
    "ssh daniel-pi 'bash -c sh' <<'EOF'\nsystemctl start homelab-reconcile\nEOF",
    "eval systemctl start homelab-reconcile",
    "x='systemctl start homelab-reconcile'; echo \"$x\" | ssh daniel-pi sh",
    "x='systemctl start homelab-reconcile'; ssh daniel-pi \"$x\"",
    "x='systemctl start homelab-reconcile'; ssh daniel-pi $x",
    "x='systemctl start homelab-reconcile'; $x",
    "x='systemctl start homelab-reconcile'; out=$(ssh daniel-pi \"$x\")",
    'x=\'systemctl start homelab-reconcile\'; y="cd / && $x"; ssh daniel-pi "$y"',
    'x=\'ssh daniel-pi "systemctl start homelab-reconcile"\'; bash -c "$x"',
    "unit=homelab-reconcile; ssh daniel-pi sh <<EOF\nsystemctl start $unit\nEOF",
]
WRITES = DISPATCHES + BOOTSTRAPS + RECONCILES
NOT_WRITES = [
    "gh workflow view promote.yml",
    "gh workflow run ci.yml -f ref=promote.yml",
    "gh run list --workflow promote.yml",
    "echo gh workflow run promote.yml",
    "shellcheck hosts/bootstrap-host.sh",
    "bash -n hosts/bootstrap-host.sh",
    "bash -xn hosts/bootstrap-host.sh",
    "git log -- hosts/bootstrap-host.sh",
    "ssh daniel-server systemctl status homelab-reconcile",
    "ssh daniel-server journalctl -u homelab-reconcile",
    "systemctl enable homelab-reconcile.timer",
    "systemctl start other.service",
    "bash -n < hosts/bootstrap-host.sh",
    "bash lint.sh < hosts/bootstrap-host.sh",
    "ssh daniel-pi 'cat > /tmp/b.sh' < hosts/bootstrap-host.sh",
    "cat > x.sh <<'EOF'\nsystemctl start homelab-reconcile\nEOF",
    "sed '' hosts/bootstrap-host.sh | head",
    "diff <(cat hosts/bootstrap-host.sh) <(ssh daniel-pi cat /tmp/bootstrap-host.sh)",
    "bash lint.sh <(cat hosts/bootstrap-host.sh)",
    "cat hosts/bootstrap-host.sh; ssh daniel-pi sh",
    "echo 'systemctl start homelab-reconcile' | tee notes.txt",
    "printf '%s\\n' 'systemctl start homelab-reconcile' > x.sh",
    "tee >(wc -l) < hosts/bootstrap-host.sh",
    "sh lint.sh > >(tee log.txt) < hosts/bootstrap-host.sh",
    "source lint.sh hosts/bootstrap-host.sh",
    "bash -c 'cat > /tmp/b.sh' < hosts/bootstrap-host.sh",
    "bash -c 'sh lint.sh' < hosts/bootstrap-host.sh",
    'eval "$(ssh-agent -s)"',
    'echo "$(cat hosts/bootstrap-host.sh)"',
    "x='systemctl start homelab-reconcile'; echo \"$x\"",
    "x='systemctl start homelab-reconcile'; echo '$x' | ssh daniel-pi sh",
    "unit=homelab-reconcile; ssh daniel-pi sh <<'EOF'\nsystemctl start $unit\nEOF",
    "x='systemctl status homelab-reconcile'; ssh daniel-pi \"$x\"",
]
# Payloads to a trusted ssh host, which the judge's trusted-host arm would otherwise allow.
TRUSTED_HOST_WRITES = [
    "ssh daniel-server systemctl start homelab-reconcile",
    "ssh daniel-pi hosts/bootstrap-host.sh daniel-pi",
    "ssh daniel-server gh workflow run promote.yml",
    "ssh daniel-server -- systemctl start homelab-reconcile",
    "ssh daniel-server -t 'systemctl start homelab-reconcile'",
    "ssh daniel-server 'cd /srv && bash -e -o pipefail hosts/bootstrap-host.sh daniel-pi'",
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
