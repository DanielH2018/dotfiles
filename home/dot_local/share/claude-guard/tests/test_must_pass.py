"""The must-pass corpus: commands claude-guard must never refuse, seeded from transcript denials.

Each row goes through the PreToolUse hook as Claude Code sends it, against the real settings
template, and the false-deny budget is zero: a deny or an ask fails the row. A HEADLESS row
must also pass the headless prompt tool, which answers the prompt a `claude -p` session cannot.
To add a row, cut a real denial down to the shape that reproduced it.
"""

import json

import pytest

from claude_guard import prompt_tool
from claude_guard.hook import pre_tool_use

# Rows the deny side must pass. The judge may still defer them to a prompt.
MUST_PASS = [
    # greps and prose that name dangerous words (dotfiles #967, Evidence)
    "J='grep -rnE \"break-glass|rollback|kill switch\" docs/ and ls $(git rev-parse --show-toplevel)'"
    "; printf '%s\\n' \"$J\"",
    "git commit -m 'Record the rollback|kill switch grep, run at $(git rev-parse HEAD)'",
    "git commit -m 'Document that the operator runs sudo reboot after a kernel update'",
    "cat > /tmp/notes.md <<'EOF'\nRun `sudo rm -rf /var/lib/rancher` only during break-glass.\nEOF",
    "python3 - <<'EOF'\nopen(\"/tmp/x.md\",\"w\").write(\"run sudo systemctl restart foo\")\nEOF",
    # a read-only path under a secret directory
    "git show --no-textconv --numstat --format='%h %s' HEAD -- ansible/vars/secrets.yml",
    # forms the Linux sandbox must still pass (dotfiles #1247)
    "sudo -n /usr/local/sbin/homelab-takeover-check",
    "scripts/deploy_tools/land.sh --pr 123 --arm-merge --await-merge --detach",
    "land.sh --detach && cc-wait land",
    "cc-wait pr 123",
    "kubectl -n observability logs deploy/loki --tail=50 | grep -i error",
    "openssl rand -base64 32 | jq -Rc . | sops set --value-stdin ansible/vars/secrets.yml"
    " '[\"grafana_token\"]'",
]

# Rows that must pass end to end in a headless session.
HEADLESS = [
    # greps that name dangerous words
    'grep -rnE "break-glass|rollback|kill switch" docs/',
    'grep -rn "\\.env" docs/',
    "git grep -n -E 'pkill|killall' -- docs",
    "rg -n 'rm -rf /' docs/",
    "grep -rn 'sudo ' docs/ | head -20",
    'git grep -n -E "kuma-push\\.env|live-drift-check\\.env" -- ansible',
    "grep -c 'credentials.json\\|\\*\\*/.env' home/.chezmoitemplates/settings.base.json",
    "sed -n '/cluster-vars.sops.env/p' docs/landing.md",
    # prose that mentions a privileged command
    "echo 'run sudo systemctl restart k3s by hand'",
    # read-only paths under secret directories
    "ls -la ~/.ssh",
    "ls -l ~/.ssh/config",
    "ls ~/.config/sops/age",
    "stat -c '%a %U' ~/.ssh/id_ed25519",
    # piped and compound ssh and kubectl
    "ssh daniel-server 'journalctl -u k3s --since -1h --no-pager' | tail -20",
    "ssh daniel-pi uptime && ssh daniel-server uptime",
    "ssh daniel-server 'systemctl is-active k3s; df -h /'",
    "kubectl get pods -A | grep -v Running",
    "kubectl get nodes && kubectl get pods -n flux-system",
    # forms the Linux sandbox must still pass
    "rootq --help",
    "takeover-check --help",
    "cc-wait --list",
    # interpreters (dotfiles #967's consequence table)
    "uv run python -c 'print(1)'",
    "uv run python scripts/x.py",
]


@pytest.fixture
def env(tmp_path, template_permissions):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    settings = {"permissions": template_permissions}
    (home / ".claude" / "settings.json").write_text(json.dumps(settings))
    return {"HOME": str(home), "PATH": "/usr/bin:/bin"}


@pytest.fixture
def cwd(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    return str(repo)


def hook_verdict(command: str, cwd: str, env: dict[str, str]) -> str:
    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "cwd": cwd,
        "tool_use_id": "toolu_corpus",
    }
    out = pre_tool_use(json.dumps(payload), env)
    return json.loads(out)["hookSpecificOutput"].get("permissionDecision", "none") if out else "none"


@pytest.mark.parametrize("command", MUST_PASS + HEADLESS)
def test_the_deny_side_passes_every_corpus_row(command, cwd, env):
    assert hook_verdict(command, cwd, env) in ("none", "allow")


@pytest.mark.parametrize("command", HEADLESS)
def test_a_headless_session_runs_every_headless_row(command, cwd, env):
    assert hook_verdict(command, cwd, env) in ("none", "allow")
    request = {"tool_name": "Bash", "input": {"command": command}, "tool_use_id": "toolu_corpus"}
    assert prompt_tool.decide(request, env)["behavior"] == "allow"
