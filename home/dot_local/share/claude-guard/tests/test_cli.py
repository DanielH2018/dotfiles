"""The CLI, driven as a subprocess the way the shims and a human will drive it -- except the
slice-4 tests below, which drive `cli.main()` in-process so they can monkeypatch `cli`'s own
names (`cli.pre_tool_use`, `cli.deny`)."""

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from claude_guard import cli
from claude_guard.deny import NONE
from claude_guard.hook import ASK_JSON, DENY_LOG_NAME

PKG_DIR = Path(__file__).resolve().parents[1]


def run_cli(argv: list[str], stdin: str = "") -> tuple[int, str]:
    old_stdin = sys.stdin
    sys.stdin = io.StringIO(stdin)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            rc = cli.main(argv)
    finally:
        sys.stdin = old_stdin
    return rc, out.getvalue()


def write_corpus(tmp_path, commands: list[str]) -> str:
    p = tmp_path / "corpus.jsonl"
    p.write_text("".join(json.dumps({"command": c, "cwd": "/tmp"}) + "\n" for c in commands))
    return str(p)


def run(*args: str, stdin: str = "") -> subprocess.CompletedProcess:
    # CLAUDE_GUARD_SETTINGS_HOME beats HOME (rules.py:14), so pointing it at a fresh,
    # empty temp dir keeps the real ~/.claude/settings.json out of every test's rules
    # deliberately -- not as a side effect of HOME being absent from this dict.
    with tempfile.TemporaryDirectory() as settings_home:
        return subprocess.run(
            [sys.executable, "-S", "-m", "claude_guard.cli", *args],
            input=stdin,
            capture_output=True,
            text=True,
            cwd=PKG_DIR,
            env={
                "PYTHONPATH": str(PKG_DIR),
                "PATH": "/usr/bin:/bin",
                "CLAUDE_GUARD_SETTINGS_HOME": settings_home,
            },
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
        },
    )
    assert (r.returncode, r.stdout) == (0, "")


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


def test_explain_cwd_flag_threads_into_the_git_reset_check(tmp_path):
    # Fix round 1, F8: `grep -rn -- "--cwd" tests/` returned nothing before this. `--cwd`
    # is the only way a subprocess-driven `explain` call can exercise a cwd-sensitive
    # check at all, so without this test the flag's wiring (cli.py's cmd_explain reading
    # args.cwd rather than always falling back to os.getcwd()) could silently break.
    from test_git_reset import _make_repo

    home = home_with_allow(tmp_path, "Bash(ls:*)")
    work = _make_repo(tmp_path)
    not_a_repo = tmp_path / "plain"
    not_a_repo.mkdir()

    clean = run_home(home, "explain", "--cwd", work, "git reset --hard origin/master")
    assert clean.stdout.splitlines()[-1] == "decision: allow rule=git-reset-check"

    elsewhere = run_home(
        home, "explain", "--cwd", str(not_a_repo), "git reset --hard origin/master"
    )
    assert elsewhere.stdout.splitlines()[-1] == "decision: defer rule=segment:0:unlisted"


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


def test_replay_refuses_neither_mode(tmp_path):
    # The --judge+--deny case is test_replay_refuses_deny_with_judge below.
    corpus = tmp_path / "c.jsonl"
    corpus.write_text(json.dumps({"command": "ls", "cwd": "/tmp"}) + "\n")
    assert run("replay", str(corpus)).returncode == 2


# --- slice 4: pre-tool-use, shadow-report --deny, replay --deny ------------------------------

DENY_HOOK_SRC = HOOKS_DIR / "executable_block-dangerous-bash.sh"


def test_pre_tool_use_prints_the_deny_line_live(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_GUARD_DENY_SHADOW", "0")
    rc, out = run_cli(["pre-tool-use"], stdin=json.dumps({"tool_input": {"command": "rm -rf /"}}))
    assert rc == 0
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_pre_tool_use_prints_nothing_in_shadow(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CLAUDE_SHADOW_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("CLAUDE_GUARD_BASH_HOOKS_DIR", str(tmp_path / "nohooks"))
    monkeypatch.delenv("CLAUDE_GUARD_DENY_SHADOW", raising=False)
    rc, out = run_cli(["pre-tool-use"], stdin=json.dumps({"tool_input": {"command": "rm -rf /"}}))
    assert (rc, out) == (0, "")
    assert (tmp_path / "logs" / DENY_LOG_NAME).exists()


def test_pre_tool_use_prints_ask_when_the_hook_function_raises(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(cli, "pre_tool_use", boom)
    monkeypatch.setenv("CLAUDE_GUARD_DENY_SHADOW", "0")
    rc, out = run_cli(["pre-tool-use"], stdin=json.dumps({"tool_input": {"command": "ls"}}))
    assert (rc, out.strip()) == (0, ASK_JSON)


def test_shadow_report_reads_the_deny_log_by_default(tmp_path, monkeypatch):
    # shadow-report is deny-only (slice 6 retired the allow side's log and report half --
    # claude_guard.hook's module docstring), so no --deny flag is needed or accepted.
    monkeypatch.setenv("CLAUDE_SHADOW_LOG_DIR", str(tmp_path))
    rows = [
        {"ts": "t", "cmd_sha": "0" * 16, "python": "deny", "bash": "deny", "rule": "rm-root"},
        {"ts": "t", "cmd_sha": "1" * 16, "python": "deny", "bash": "none", "rule": "pkill"},
    ]
    (tmp_path / DENY_LOG_NAME).write_text("".join(json.dumps(r) + "\n" for r in rows))
    rc, out = run_cli(["shadow-report"])
    assert rc == 0
    assert "records 2" in out and "agree 1 (deny 1, ask 0, none 0, allow 0)" in out
    assert "python-only 1" in out and "  pkill: 1" in out
    assert "mismatch 0" in out and "python-error 0" in out and "bash-error 0" in out


def test_replay_deny_prints_rule_lines_and_the_command_head(tmp_path):
    corpus = write_corpus(tmp_path, ["rm -rf /", "ls -la", "git push --force origin feat"])
    rc, out = run_cli(["replay", corpus, "--deny"])
    assert rc == 0
    lines = out.splitlines()
    assert lines[0] == "DENY rm-root: rm -rf /"
    assert lines[1] == "ALLOW force-push-upgrade: git push --force origin feat"
    assert "ls -la" not in out


@pytest.mark.skipif(not (shutil.which("bash") and shutil.which("jq")), reason="bash unavailable")
def test_replay_deny_compare_hook_reports_agreement(tmp_path):
    corpus = write_corpus(tmp_path, ["rm -rf /", "ls -la", "terraform apply", "env"])
    rc, out = run_cli(["replay", corpus, "--deny", "--compare-hook", str(DENY_HOOK_SRC)])
    assert rc == 0
    assert out.splitlines()[-1] == "AGREE 4/4"


@pytest.mark.skipif(not (shutil.which("bash") and shutil.which("jq")), reason="bash unavailable")
def test_replay_deny_compare_hook_names_a_mismatch_and_exits_one(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "deny", lambda command, cwd="", env=None: NONE)
    corpus = write_corpus(tmp_path, ["rm -rf /"])
    rc, out = run_cli(["replay", corpus, "--deny", "--compare-hook", str(DENY_HOOK_SRC)])
    assert rc == 1
    assert "MISMATCH: rm -rf / python=none bash=deny" in out
    assert out.splitlines()[-1] == "AGREE 0/1"


def test_replay_refuses_deny_with_judge(tmp_path):
    corpus = write_corpus(tmp_path, ["ls"])
    rc, _ = run_cli(["replay", corpus, "--deny", "--judge"])
    assert rc == 2
