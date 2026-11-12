"""The must-pass corpus: commands claude-guard must never refuse, seeded from transcript denials.

Each row goes through the PreToolUse hook as Claude Code sends it, against the real settings
template, and the false-deny budget is zero: a deny or an ask fails the row. Every row also
states its verdict in a headless session, where the prompt tool answers the prompt a
`claude -p` session cannot. A HEADLESS row must pass there. A PROMPTED row must be refused
there, and carries the reason its prompt is deliberate; a row with no such reason belongs in
HEADLESS. To add a row, cut a real denial down to the shape that reproduced it.
"""

import json

import pytest

from claude_guard import prompt_tool
from claude_guard.deny import deny
from claude_guard.hook import pre_tool_use

PROMPTED = {
    # a grep that names dangerous words (dotfiles #967, Evidence)
    "J='grep -rnE \"break-glass|rollback|kill switch\" docs/ and ls $(git rev-parse HEAD)'"
    "; printf '%s\\n' \"$J\"": "`J` is not on claude_guard.assignments' standalone allowlist",
    # forms the Linux sandbox must still pass (dotfiles #1247)
    "sudo -n /usr/local/sbin/homelab-takeover-check": (
        "the template denies sudo on every host but daniel-box; `takeover-check` is the"
        " headless form"
    ),
    "scripts/deploy_tools/land.sh --pr 123 --arm-merge --await-merge --detach": (
        "landing merges a PR, which a session does only when asked"
    ),
    "land.sh --detach && cc-wait land": (
        "landing merges a PR, and `land` is a repo-defined wait source, which runs that repo's code"
    ),
    "openssl rand -base64 32 | jq -Rc . | sops set --value-stdin ansible/vars/secrets.yml"
    " '[\"grafana_token\"]'": "/add-secret says to expect a prompt before a secret is written",
}

HEADLESS = [
    # greps and prose that name dangerous words
    "git commit -m 'Record the rollback|kill switch grep, run at $(git rev-parse HEAD)'",
    "git commit -m 'Document that the operator runs sudo reboot after a kernel update'",
    "cat > /tmp/notes.md <<'EOF'\nRun `sudo rm -rf /var/lib/rancher` only during break-glass.\nEOF",
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
    'python3 - <<EOF\nopen("/tmp/x.md","w").write("run sudo systemctl restart foo")\nEOF',
    # read-only paths under secret directories
    "ls -la ~/.ssh",
    "ls -l ~/.ssh/config",
    "ls ~/.config/sops/age",
    "stat -c '%a %U' ~/.ssh/id_ed25519",
    "git show --no-textconv --numstat --format='%h %s' HEAD -- ansible/vars/secrets.yml",
    # piped and compound ssh and kubectl
    "ssh daniel-server 'journalctl -u k3s --since -1h --no-pager' | tail -20",
    "ssh daniel-pi uptime && ssh daniel-server uptime",
    "ssh daniel-server 'systemctl is-active k3s; df -h /'",
    "kubectl get pods -A | grep -v Running",
    "kubectl get nodes && kubectl get pods -n flux-system",
    "kubectl -n observability logs deploy/loki --tail=50 | grep -i error",
    # forms the Linux sandbox must still pass
    "rootq --help",
    "takeover-check --help",
    "cc-wait --list",
    "cc-wait gh-pr 123",
    # interpreters, one class however spelled (dotfiles #967's consequence table)
    "python3 -c 'print(1)'",
    "python -c 'print(1)'",
    "python3 - <<'EOF'\nprint(1)\nEOF",
    "python - <<'EOF'\nprint(1)\nEOF",
    "uv run python -c 'print(1)'",
    "uv run python - <<'EOF'\nprint(1)\nEOF",
    "uv run python scripts/x.py",
]

# Each deny check that guards an interpreter, through each interpreter form. The deny layer
# never sees the body of `uv run python <file>`, so that form's cases put the dangerous text
# on the command line, and it has no in-place edit case.
SECRET = "/home/u/.ssh/id_rsa"
SED = "sed -i 's/a/b/' ~/.bashrc"
MUST_REFUSE = [
    ("secret-read-interpreter", f"python3 -c \"print(open('{SECRET}').read())\""),
    ("secret-read-interpreter", f"python3 - <<'EOF'\nprint(open('{SECRET}').read())\nEOF"),
    ("secret-read-interpreter", f"uv run python -c \"print(open('{SECRET}').read())\""),
    ("secret-read-interpreter", f"uv run python - <<'EOF'\nprint(open('{SECRET}').read())\nEOF"),
    ("secret-read-interpreter", "uv run python scripts/dump.py ~/.ssh/id_rsa"),
    ("pipe-to-shell", "python3 -c 'print(\"id\")' | sh"),
    ("pipe-to-shell", "python3 - <<'EOF' | sh\nprint('id')\nEOF"),
    ("pipe-to-shell", "uv run python -c 'print(\"id\")' | sh"),
    ("pipe-to-shell", "uv run python - <<'EOF' | sh\nprint('id')\nEOF"),
    ("pipe-to-shell", "uv run python scripts/gen.py | sh"),
    ("inplace-edit", f'python3 -c "import os; os.system(\\"{SED}\\")"'),
    ("inplace-edit", f"python3 - <<'EOF'\nimport os\nos.system(\"{SED}\")\nEOF"),
    ("inplace-edit", f'uv run python -c "import os; os.system(\\"{SED}\\")"'),
    ("inplace-edit", f"uv run python - <<'EOF'\nimport os\nos.system(\"{SED}\")\nEOF"),
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
    return (
        json.loads(out)["hookSpecificOutput"].get("permissionDecision", "none") if out else "none"
    )


def headless_verdict(command: str, cwd: str, env: dict[str, str]) -> str:
    """The deny side's verdict, then the prompt tool's: "allow" only when both pass."""
    if hook_verdict(command, cwd, env) not in ("none", "allow"):
        return "denied by the hook"
    request = {"tool_name": "Bash", "input": {"command": command}, "tool_use_id": "toolu_corpus"}
    return prompt_tool.decide(request, env)["behavior"]


@pytest.mark.parametrize("command", HEADLESS)
def test_a_headless_session_runs_every_headless_row(command, cwd, env):
    assert headless_verdict(command, cwd, env) == "allow"


@pytest.mark.parametrize("command", PROMPTED)
def test_a_prompted_row_passes_the_hook_and_is_left_to_its_prompt(command, cwd, env):
    assert headless_verdict(command, cwd, env) == "deny", PROMPTED[command]


@pytest.mark.parametrize(("rule", "command"), MUST_REFUSE)
def test_each_interpreter_form_still_meets_the_deny_checks(rule, command, cwd, env):
    assert deny(command, cwd, env).rule == rule
    assert hook_verdict(command, cwd, env) == "deny"
