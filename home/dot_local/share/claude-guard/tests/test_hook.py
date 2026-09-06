"""The PermissionRequest contract: stdin JSON in, a decision line or nothing out.

Function-level here; Task 6 appends the tests that drive the shim as a subprocess with a
temp HOME the way tests/hooks/allow-compound-bash.test.js drives the bash hook.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from claude_guard import hook
from claude_guard.hook import ALLOW_JSON, LOG_NAME, permission_request, shadow_mode, summarize
from claude_guard.judge import Decision

PKG_DIR = Path(__file__).resolve().parents[1]
HOOKS = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"

skip_no_bash = pytest.mark.skipif(
    not (
        shutil.which("bash")
        and shutil.which("jq")
        and (HOOKS / "executable_allow-compound-bash.sh").exists()
    ),
    reason="bash chain unavailable",
)

PERMS = {
    "allow": ["Bash(git status:*)", "Bash(ls:*)", "Bash(echo:*)"],
    "deny": ["Bash(rm:*)"],
    "ask": [],
}


def home_with(tmp_path: Path, perms: dict = PERMS) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"permissions": perms}))
    return home


def payload(command: str) -> str:
    return json.dumps({"tool_input": {"command": command}})


def env_for(home: Path, **extra: str) -> dict[str, str]:
    return {"HOME": str(home), "PATH": "/usr/bin:/bin", **extra}


# --- live mode -----------------------------------------------------------------------------


def test_live_mode_prints_the_allow_line_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    assert (
        permission_request(payload("git status && ls"), env_for(home, CLAUDE_GUARD_SHADOW="0"))
        == ALLOW_JSON
    )


def test_live_mode_prints_nothing_for_a_refused_chain(tmp_path):
    home = home_with(tmp_path)
    assert (
        permission_request(
            payload("git status && rm -rf /"), env_for(home, CLAUDE_GUARD_SHADOW="0")
        )
        is None
    )


def test_malformed_or_command_less_stdin_is_no_decision(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="0")
    assert permission_request("{ not json", env) is None
    assert permission_request(json.dumps({"tool_input": {}}), env) is None
    assert permission_request(json.dumps({"tool_input": {"command": 5}}), env) is None
    assert permission_request("", env) is None


# --- the env contract ----------------------------------------------------------------------


def test_shadow_mode_is_off_unless_the_variable_is_exactly_1():
    assert shadow_mode({}) == (False, False)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "0"}) == (False, False)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1"}) == (True, True)


def test_sampling_governs_logging_only_and_the_roll_seam_picks_the_branch():
    on = {"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "10"}
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "0"}) == (True, True)
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "3"}) == (True, False)
    # A malformed denominator falls back to logging every call, never to deciding.
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "x"}) == (
        True,
        True,
    )


# --- shadow mode ---------------------------------------------------------------------------


@skip_no_bash
def test_shadow_mode_prints_nothing_and_logs_one_line_that_agrees_with_the_bash_chain(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    lines = (log_dir / LOG_NAME).read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["python"] == "allow" and rec["bash"] == "allow"
    assert rec["bash_hook"] == "allow-compound-bash.sh"
    assert rec["rule"] == "allow"
    assert len(rec["cmd_sha"]) == 16 and rec["ts"].endswith("Z")


@skip_no_bash
def test_shadow_mode_logs_a_refusal_both_sides_agree_on(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && rm -rf /"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == ("none", "none", None)
    assert rec["rule"] == "segment:1:deny"


def test_shadow_log_records_a_disagreement_so_the_comparison_can_go_red(tmp_path):
    # A fake bash chain that allows everything: python says none, bash says allow.
    fake = tmp_path / "hooks"
    fake.mkdir()
    for name in hook.BASH_CHAIN:
        p = fake / name
        p.write_text(
            "#!/bin/bash\ncat >/dev/null\n"
            'printf \'{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}\\n\'\n'
        )
        p.chmod(0o755)
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && frobnicate"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == (
        "none",
        "allow",
        "allow-compound-bash.sh",
    )


def test_the_shadow_log_never_carries_the_command(tmp_path):
    fake = tmp_path / "hooks"
    fake.mkdir()  # no hooks at all: bash side is "none"
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    permission_request(payload("git status && ls /very/secret/path"), env, log_dir=log_dir)
    text = (log_dir / LOG_NAME).read_text()
    assert "secret" not in text
    assert set(json.loads(text)) == {"ts", "cmd_sha", "python", "bash", "rule", "bash_hook"}


def test_a_sampled_miss_still_decides_nothing_and_writes_nothing(tmp_path):
    home = home_with(tmp_path)
    env = env_for(
        home,
        CLAUDE_GUARD_SHADOW="1",
        CLAUDE_GUARD_SHADOW_SAMPLE="10",
        CLAUDE_GUARD_SHADOW_ROLL="7",
        CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path),
    )
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    assert not (log_dir / LOG_NAME).exists()


def test_an_unwritable_log_dir_is_swallowed(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path))
    blocked = tmp_path / "file-not-dir"
    blocked.write_text("")
    assert permission_request(payload("git status && ls"), env, log_dir=blocked / "logs") is None


def _fake_chain(tmp_path: Path, script: str) -> Path:
    """A hooks dir where every BASH_CHAIN member is `script`, so the first one hit governs."""
    fake = tmp_path / "hooks"
    fake.mkdir()
    for name in hook.BASH_CHAIN:
        p = fake / name
        p.write_text(script)
        p.chmod(0o755)
    return fake


def test_a_bash_hook_that_exits_nonzero_is_treated_as_no_allow(tmp_path, monkeypatch):
    fake = _fake_chain(tmp_path, "#!/bin/bash\ncat >/dev/null\nexit 1\n")
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    # Live mode too: a bash-chain hook failing must not be mistaken for a python decision.
    assert (
        permission_request(payload("git status && ls"), env_for(home, CLAUDE_GUARD_SHADOW="0"))
        is not None
    )
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert rec["bash"] == "none" and rec["bash_hook"] is None


def test_a_bash_hook_that_hangs_past_the_timeout_is_treated_as_no_allow(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "_HOOK_TIMEOUT", 0.2)
    fake = _fake_chain(tmp_path, "#!/bin/bash\ncat >/dev/null\nsleep 5\n")
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert rec["bash"] == "none" and rec["bash_hook"] is None


# --- shadow-report -------------------------------------------------------------------------


def test_summarize_counts_agreement_and_names_the_rules_behind_each_disagreement():
    rows = [
        {
            "python": "allow",
            "bash": "allow",
            "rule": "allow",
            "bash_hook": "allow-compound-bash.sh",
        },
        {"python": "none", "bash": "none", "rule": "segment:1:deny", "bash_hook": None},
        {
            "python": "none",
            "bash": "allow",
            "rule": "segment:0:redirect",
            "bash_hook": "allow-safe-curl.sh",
        },
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
    ]
    s = summarize(json.dumps(r) for r in rows)
    assert s["records"] == 5
    assert s["agree"] == 2 and s["agree_allow"] == 1 and s["agree_none"] == 1
    assert s["python_only"] == 2 and s["bash_only"] == 1
    assert s["python_only_rules"] == {"allow": 2}
    assert s["bash_only_rules"] == {"segment:0:redirect (allow-safe-curl.sh)": 1}


def test_summarize_skips_an_unparseable_line_and_reports_it():
    s = summarize(
        ["{ nope", json.dumps({"python": "none", "bash": "none", "rule": "x", "bash_hook": None})]
    )
    assert s["records"] == 1 and s["unparseable"] == 1


def test_summarize_treats_a_non_dict_or_keyless_record_as_unparseable():
    lines = [json.dumps(v) for v in (5, [1, 2], {})]
    good = json.dumps({"python": "none", "bash": "none", "rule": "x", "bash_hook": None})
    s = summarize([*lines, good])
    assert s["records"] == 1
    assert s["unparseable"] == 3
    assert s["agree"] == 1 and s["agree_none"] == 1


def test_shadow_record_shape():
    rec = hook.shadow_record("ls; pwd", Decision(True, "allow", ("allow-list", "allow-list")), None)
    assert rec["python"] == "allow" and rec["bash"] == "none" and rec["rule"] == "allow"
    assert rec["cmd_sha"] == hook.command_sha("ls; pwd")


# --- the shim, driven as the harness drives it ---------------------------------------------

SHIM = HOOKS / "executable_guard-permission-request.sh"
BASH = shutil.which("bash") or "/bin/bash"
skip_no_uv = pytest.mark.skipif(not shutil.which("uv"), reason="uv unavailable")


def run_shim(stdin_text: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(SHIM)], input=stdin_text, capture_output=True, text=True, env=env
    )


def shim_env(home: Path, **extra: str) -> dict[str, str]:
    # XDG_DATA_HOME pins uv's managed-python lookup to the REAL home's install dir: `uv python
    # find` derives its search path from $HOME (or $XDG_DATA_HOME) at call time, so a fake HOME
    # here (needed so permission_request() reads an isolated settings.json) would otherwise make
    # the managed 3.14 toolchain undiscoverable, independent of the shim's own behaviour.
    return {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "XDG_DATA_HOME": str(Path.home() / ".local" / "share"),
        "CLAUDE_GUARD_HOME": str(PKG_DIR),
        "CLAUDE_GUARD_BASH_HOOKS_DIR": str(HOOKS),
        **extra,
    }


@skip_no_uv
def test_shim_prints_the_allow_line_when_told_to_run_live(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(payload("git status && ls"), shim_env(home, CLAUDE_GUARD_SHADOW="0"))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


@skip_no_uv
def test_shim_defaults_to_shadow_when_the_variable_is_absent(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(
        payload("git status && ls"), shim_env(home, CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    )
    assert (r.returncode, r.stdout) == (0, "")
    assert (tmp_path / "logs" / LOG_NAME).exists()


@skip_no_uv
def test_shim_in_shadow_prints_nothing_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")
    rec = json.loads((tmp_path / "logs" / LOG_NAME).read_text())
    assert rec["python"] == "allow"


def test_shim_prints_nothing_and_exits_zero_without_an_interpreter(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", PATH="/nonexistent")
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")


def test_shim_prints_nothing_and_exits_zero_when_the_package_is_missing(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")
