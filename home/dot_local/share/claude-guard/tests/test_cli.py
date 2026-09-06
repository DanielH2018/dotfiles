"""The CLI, driven as a subprocess the way the shims and a human will drive it."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

PKG_DIR = Path(__file__).resolve().parents[1]
CMDPARSE = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks" / "executable_cmdparse.sh"


def run(*args: str, stdin: str = "") -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", *args],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=PKG_DIR,
        env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin"},
    )


def test_segment_json_matches_the_bash_shape():
    r = run("segment", "--json", stdin="ls; cat <<'EOF'\nx\nEOF")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert out == {
        "status": "ok",
        "nseg": 2,
        "seg": ["ls", " cat <<'EOF'"],
        "sep": [";", "eof"],
        "heredoc": ["", "x\n"],
        "subseg": [],
    }


def test_segment_json_reports_a_refusal_as_a_status_not_an_error():
    r = run("segment", "--json", stdin="echo 'oops")
    assert r.returncode == 0
    assert json.loads(r.stdout)["status"] == "unreadable:unbalanced-quote"


def test_explain_prints_one_line_per_segment_with_its_separator():
    r = run("explain", "git status && ls & rm -rf /")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert lines[0] == "status: ok"
    assert lines[1] == "[0] sep=&& heredocs=0: git status"
    assert lines[2] == "[1] sep=& heredocs=0: ls"
    assert lines[3] == "[2] sep=eof heredocs=0: rm -rf /"


def test_explain_lists_substitutions():
    r = run("explain", "echo $(id)")
    assert "sub[0]: id" in r.stdout


def test_explain_on_a_refusal_exits_nonzero_and_says_why():
    r = run("explain", "echo 'oops")
    assert r.returncode == 1
    assert "status: unreadable:unbalanced-quote" in r.stdout


@pytest.mark.skipif(not CMDPARSE.exists(), reason="bash segmenter not beside a deployed copy")
def test_replay_compare_bash_reports_parity(tmp_path):
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"})
        + "\n"
        + json.dumps({"command": "cat <<'EOF'\nx\nEOF\nls", "cwd": "/tmp"})
        + "\n"
    )
    r = run("replay", str(corpus), "--compare-bash", str(CMDPARSE))
    assert r.returncode == 0, r.stderr + r.stdout
    assert r.stdout.strip().splitlines()[-1] == "PARITY 2/2"


@pytest.mark.skipif(not CMDPARSE.exists(), reason="bash segmenter not beside a deployed copy")
def test_replay_compare_bash_exits_nonzero_on_a_mismatch(tmp_path, monkeypatch):
    # A fake bash segmenter that disagrees on purpose proves the comparison can go red.
    fake = tmp_path / "fake-cmdparse.sh"
    fake_json = json.dumps(
        {"status": "ok", "nseg": 1, "seg": ["nope"], "sep": ["eof"], "heredoc": [""], "subseg": []}
    )
    fake.write_text(f"#!/bin/bash\ncat >/dev/null\nprintf '{fake_json}\\n'\n")
    fake.chmod(0o755)
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls", "cwd": "/tmp"}) + "\n")
    r = run("replay", str(corpus), "--compare-bash", str(fake))
    assert r.returncode == 1
    assert "PARITY 0/1" in r.stdout
    assert "MISMATCH" in r.stdout


def test_permission_request_prints_the_allow_line_in_live_mode(tmp_path):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash(ls:*)", "Bash(pwd)"], "deny": [], "ask": []}})
    )
    r = subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", "permission-request"],
        input=json.dumps({"tool_input": {"command": "ls; pwd"}}),
        capture_output=True,
        text=True,
        cwd=PKG_DIR,
        env={
            "PYTHONPATH": str(PKG_DIR),
            "PATH": "/usr/bin:/bin",
            "HOME": str(home),
            "CLAUDE_GUARD_SHADOW": "0",
        },
    )
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


def test_permission_request_prints_nothing_and_exits_zero_on_garbage(tmp_path):
    r = subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", "permission-request"],
        input="{ nope",
        capture_output=True,
        text=True,
        cwd=PKG_DIR,
        env={
            "PYTHONPATH": str(PKG_DIR),
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp_path),
            "CLAUDE_GUARD_SHADOW": "0",
        },
    )
    assert (r.returncode, r.stdout) == (0, "")


def test_shadow_report_prints_counts_and_never_a_command(tmp_path):
    log = tmp_path / "claude-guard-shadow.jsonl"
    log.write_text(
        json.dumps(
            {
                "python": "allow",
                "bash": "allow",
                "rule": "allow",
                "bash_hook": "allow-compound-bash.sh",
            }
        )
        + "\n"
        + json.dumps(
            {
                "python": "none",
                "bash": "allow",
                "rule": "segment:1:ask",
                "bash_hook": "allow-safe-rm.sh",
            }
        )
        + "\n"
        # An agreement row whose rule text happens to embed a path: agreeing rows are only
        # counted, never printed by name, so this must not leak into the report either.
        + json.dumps(
            {
                "python": "allow",
                "bash": "allow",
                "rule": "wrapper:/very/secret/path",
                "bash_hook": "allow-compound-bash.sh",
            }
        )
        + "\n"
    )
    r = run("shadow-report", "--log", str(log))
    assert r.returncode == 0, r.stderr
    assert "records 3" in r.stdout
    assert "agree 2 (allow 2, none 0)" in r.stdout
    assert "bash-only 1" in r.stdout
    assert "segment:1:ask (allow-safe-rm.sh): 1" in r.stdout
    assert "secret" not in r.stdout


def test_shadow_report_exits_nonzero_when_there_is_no_log(tmp_path):
    r = run("shadow-report", "--log", str(tmp_path / "absent.jsonl"))
    assert r.returncode == 1


HOOKS_DIR = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"


def home_with_allow(tmp_path: Path, *rules: str) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": list(rules), "deny": [], "ask": ["Bash(rm:*)"]}})
    )
    return home


def run_home(home: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-S", "-m", "claude_guard.cli", *args],
        capture_output=True,
        text=True,
        cwd=PKG_DIR,
        env={"PYTHONPATH": str(PKG_DIR), "PATH": "/usr/bin:/bin", "HOME": str(home)},
    )


def test_explain_prints_the_decision_and_the_rule_per_segment(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    r = run_home(home, "explain", "ls; timeout 5 pwd")
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines()[-1] == "decision: allow rule=allow"
    assert "[1] sep=eof heredocs=0: timeout 5 pwd -> wrapper:pwd" in r.stdout


def test_explain_names_the_refusing_segment(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)")
    r = run_home(home, "explain", "ls && frobnicate")
    assert r.stdout.splitlines()[-1] == "decision: defer rule=segment:1:unlisted"


def test_replay_judge_prints_the_allowed_commands_and_the_count(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"})
        + "\n"
        + json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"})
        + "\n"
        + json.dumps({"command": "rm -rf /tmp/x && ls", "cwd": "/tmp"})
        + "\n"
    )
    r = run_home(home, "replay", str(corpus), "--judge")
    assert r.returncode == 0, r.stderr
    lines = r.stdout.splitlines()
    assert lines[-1] == "ALLOW 2/3"
    assert "ALLOW: ls; pwd" in lines and "ALLOW: rm -rf /tmp/x && ls" in lines


def test_replay_judge_applies_the_records_cwd_as_the_project_scope(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    proj = tmp_path / "proj"
    (proj / ".claude").mkdir(parents=True)
    (proj / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"deny": ["Bash(pwd)"]}})
    )
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls; pwd", "cwd": str(proj)}) + "\n")
    r = run_home(home, "replay", str(corpus), "--judge")
    assert r.stdout.splitlines()[-1] == "ALLOW 0/1"


@pytest.mark.skipif(
    not (HOOKS_DIR / "executable_allow-compound-bash.sh").exists(),
    reason="bash hooks not beside a deployed copy",
)
def test_replay_compare_hooks_reports_agreement_with_the_bash_chain(tmp_path):
    home = home_with_allow(tmp_path, "Bash(ls:*)", "Bash(pwd)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(
        json.dumps({"command": "ls; pwd", "cwd": "/tmp"})
        + "\n"
        + json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"})
        + "\n"
    )
    r = run_home(home, "replay", str(corpus), "--judge", "--compare-hooks", str(HOOKS_DIR))
    assert r.returncode == 0, r.stderr + r.stdout
    assert r.stdout.splitlines()[-1] == "AGREE 2/2"


def test_replay_compare_hooks_exits_nonzero_on_a_mismatch(tmp_path):
    # A fake chain that allows everything proves the comparison can go red.
    fake = tmp_path / "hooks"
    fake.mkdir()
    (fake / "allow-compound-bash.sh").write_text(
        '#!/bin/bash\ncat >/dev/null\nprintf \'{"decision":{"behavior":"allow"}}\\n\'\n'
    )
    (fake / "allow-compound-bash.sh").chmod(0o755)
    home = home_with_allow(tmp_path, "Bash(ls:*)")
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls && frobnicate", "cwd": "/tmp"}) + "\n")
    r = run_home(home, "replay", str(corpus), "--judge", "--compare-hooks", str(fake))
    assert r.returncode == 1
    assert "MISMATCH: ls && frobnicate python=none bash=allow rule=segment:1:unlisted" in r.stdout
    assert r.stdout.splitlines()[-1] == "AGREE 0/1"


def test_replay_refuses_both_modes_or_neither(tmp_path):
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls", "cwd": "/tmp"}) + "\n")
    assert run("replay", str(corpus)).returncode == 2
    assert run("replay", str(corpus), "--judge", "--compare-bash", "/x").returncode == 2
