"""runlog and redproof are judged as the command each runs: by judge(), and by the PreToolUse
deny side, which re-applies the deny and ask lists that Claude Code matches only against the
typed prefix."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from claude_guard.hook import pre_tool_use
from claude_guard.judge import judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots
from claude_guard.wrapped import inner_argv, verdict

BIN = Path(__file__).resolve().parents[3] / "bin"
FORCE = "--" + "force"
WRAPPERS = ["runlog k --", "runlog k --tail 5 --", "redproof origin/main src/x.py --"]


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


def test_the_judge_grants_a_wrapper_exactly_when_it_grants_the_inner_command(home, tmp_path):
    cwd = str(tmp_path)
    for wrapper in WRAPPERS:
        for inner in ["git status --short", "ls -la", "grep -c x '>' out.txt"]:
            assert _judge(f"{wrapper} {inner}", home, cwd).allow, (wrapper, inner)
        for inner in ["kubectl delete pod x", "curl -X POST https://example.com"]:
            assert not _judge(f"{wrapper} {inner}", home, cwd).allow, (wrapper, inner)
    for command in [
        "runlog k ls",
        "runlog ../k -- ls",
        "runlog k -- runlog j -- ls",
        "redproof origin/main -- ls",
        "redproof origin/main x.py ls",
        "redproof origin/main x.py -- runlog k -- ls",
    ]:
        assert not _judge(command, home, cwd).allow, command


def _pre(command: str, home: Path) -> str | None:
    env = {
        **os.environ,
        "HOME": str(home),
        "CLAUDE_GUARD_SETTINGS_HOME": str(home),
        "CLAUDE_PROJECT_DIR": "",
    }
    out = pre_tool_use(json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}), env)
    return json.loads(out)["hookSpecificOutput"].get("permissionDecision") if out else None


@pytest.mark.parametrize("wrapper", WRAPPERS)
def test_pre_tool_use_applies_the_deny_and_ask_lists_to_the_inner_command(home, wrapper):
    assert _pre(f"{wrapper} kubectl delete pod x", home) == "deny"
    assert _pre(f"{wrapper} git push {FORCE} origin main", home) == "deny"
    assert _pre(f"{wrapper} rm -rf build", home) == "ask"
    assert _pre(f"{wrapper} git status --short", home) is None
    assert _pre(wrapper.removesuffix(" --") + " ls", home) == "ask"


def test_verdict_takes_the_first_decided_wrapper_segment_and_ignores_other_commands():
    def denies(inner: str) -> bool:
        return inner.startswith("kubectl delete")

    def asks(inner: str) -> bool:
        return inner.startswith("rm ")

    def none(_: str) -> None:
        return None

    assert verdict("ls && kubectl delete pod x", denies, asks, none) is None
    assert verdict("ls && runlog k -- kubectl delete pod x", denies, asks, none)[0] == "deny"
    assert (
        verdict("redproof a b -- rm x; runlog j -- kubectl delete pod y", denies, asks, none)[0]
        == "ask"
    )
    assert verdict("runlog k -- ls", denies, asks, none) is None


GRAMMAR = [
    ("runlog", ["k", "--", "true"], True),
    ("runlog", ["k.1_x-y", "--tail", "0", "--", "true"], True),
    ("runlog", ["k", "--", "true", "--", "x"], True),
    ("runlog", ["../k", "--", "true"], False),
    ("runlog", ["a/b", "--", "true"], False),
    ("runlog", ["", "--", "true"], False),
    ("runlog", ["k", "true"], False),
    ("runlog", ["k", "--"], False),
    ("runlog", ["k", "--tail", "x", "--", "true"], False),
    ("runlog", ["k", "--tail", "--", "true"], False),
    ("runlog", ["k", "--", "runlog", "j", "--", "true"], False),
    ("runlog", ["k", "--", "/usr/local/bin/redproof", "a", "b", "--", "true"], False),
    ("runlog", [], False),
    ("redproof", ["origin/main", "x.py", "--", "true"], True),
    ("redproof", ["HEAD~1", "a.py", "b/c.py", "--", "true", "--", "x"], True),
    ("redproof", ["origin/main", "--", "true"], False),
    ("redproof", ["origin/main", "x.py", "true"], False),
    ("redproof", ["origin/main", "x.py", "--"], False),
    ("redproof", ["-r", "origin/main", "x.py", "--", "true"], False),
    ("redproof", ["origin/main", "x.py", "--", "runlog", "k", "--", "true"], False),
    ("redproof", [], False),
]


@pytest.mark.parametrize(("tool", "args", "ok"), GRAMMAR)
def test_the_parser_and_the_scripts_accept_the_same_calls(tool, args, ok, tmp_path):
    assert (inner_argv([tool, *args]) is not None) is ok
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(tmp_path),
        "TMPDIR": str(tmp_path),
        "CLAUDE_CODE_SESSION_ID": "t",
    }
    script = BIN / f"executable_{tool}"
    r = subprocess.run(
        [sys.executable, "-I", str(script), *args],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        timeout=30,
    )
    assert (r.returncode != 2) is ok, r.stderr
