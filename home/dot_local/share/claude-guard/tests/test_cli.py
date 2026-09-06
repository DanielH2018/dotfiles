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
