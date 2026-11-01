"""runlog is judged as the command it runs: by judge(), and by the PreToolUse deny side, which
re-applies the deny and ask lists that Claude Code matches only against the typed prefix."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from claude_guard.hook import pre_tool_use
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.runlog import inner_argv, verdict
from claude_guard.tables import scratch_roots

TOOL = Path(__file__).resolve().parents[3] / "bin" / "executable_runlog"
FORCE = "--" + "force"


@pytest.fixture
def home(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        json.dumps(
            {
                "permissions": {
                    "allow": ["Bash(git status:*)", "Bash(ls:*)", "Bash(grep:*)"],
                    "ask": ["Bash(rm:*)"],
                    "deny": ["Bash(kubectl delete:*)"],
                }
            }
        )
    )
    return home


def _judge(command: str, home: Path, cwd: str) -> object:
    return judge(
        command, load_rules(home=str(home), project_dir=None), scratch_roots(str(home)), cwd
    )


def test_the_judge_grants_runlog_exactly_when_it_grants_the_inner_command(home, tmp_path):
    cwd = str(tmp_path)
    for inner in ["git status --short", "ls -la", "grep -c x '>' out.txt"]:
        assert _judge(f"runlog k -- {inner}", home, cwd).allow, inner
        assert _judge(f"runlog k --tail 5 -- {inner}", home, cwd).allow, inner
    for command in [
        "runlog k -- kubectl delete pod x",
        "runlog k -- curl -X POST https://example.com",
        "runlog k ls",
        "runlog ../k -- ls",
        "runlog k -- runlog j -- ls",
    ]:
        assert not _judge(command, home, cwd).allow, command


def _pre(command: str, home: Path) -> str | None:
    env = {**os.environ, "HOME": str(home), "CLAUDE_GUARD_SETTINGS_HOME": str(home), "CLAUDE_PROJECT_DIR": ""}
    out = pre_tool_use(json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}), env)
    return json.loads(out)["hookSpecificOutput"].get("permissionDecision") if out else None


def test_pre_tool_use_applies_the_deny_and_ask_lists_to_the_inner_command(home):
    assert _pre("runlog k -- kubectl delete pod x", home) == "deny"
    assert _pre(f"runlog k -- git push {FORCE} origin main", home) == "deny"
    assert _pre("runlog k -- rm -rf build", home) == "ask"
    assert _pre("runlog k ls", home) == "ask"
    assert _pre("runlog k -- git status --short", home) is None


def test_verdict_takes_the_first_decided_runlog_segment_and_ignores_other_commands():
    def denies(inner: str) -> bool:
        return inner.startswith("kubectl delete")

    def asks(inner: str) -> bool:
        return inner.startswith("rm ")

    def none(_: str) -> None:
        return None

    assert verdict("ls && kubectl delete pod x", denies, asks, none) is None
    assert verdict("ls && runlog k -- kubectl delete pod x", denies, asks, none)[0] == "deny"
    assert (
        verdict("runlog k -- rm x; runlog j -- kubectl delete pod y", denies, asks, none)[0]
        == "ask"
    )
    assert verdict("runlog k -- ls", denies, asks, none) is None


GRAMMAR = [
    (["k", "--", "true"], True),
    (["k.1_x-y", "--tail", "0", "--", "true"], True),
    (["k", "--", "true", "--", "x"], True),
    (["../k", "--", "true"], False),
    (["a/b", "--", "true"], False),
    (["", "--", "true"], False),
    (["k", "true"], False),
    (["k", "--"], False),
    (["k", "--tail", "x", "--", "true"], False),
    (["k", "--tail", "--", "true"], False),
    (["k", "--", "runlog", "j", "--", "true"], False),
    (["k", "--", "/usr/local/bin/runlog", "j", "--", "true"], False),
    ([], False),
]


@pytest.mark.parametrize(("args", "ok"), GRAMMAR)
def test_the_parser_and_the_runlog_script_accept_the_same_calls(args, ok, tmp_path):
    assert (inner_argv(["runlog", *args]) is not None) is ok
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "CLAUDE_CODE_SESSION_ID": "t",
    }
    r = subprocess.run(
        [sys.executable, "-I", str(TOOL), *args], env=env, capture_output=True, timeout=30
    )
    assert (r.returncode != 2) is ok, r.stderr
