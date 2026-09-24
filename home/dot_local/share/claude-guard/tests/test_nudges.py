"""The four context-discipline nudges (dotfiles #586).

Each rule has a command it must nudge and a bounded variant it must leave alone. The
hook-level tests pin that a nudge rides beside a verdict, never on a deny, and only once
per session.
"""

import json

import pytest

from claude_guard.deny import NONE, Verdict
from claude_guard.hook import pre_tool_use_json
from claude_guard.nudges import nudge, seen, tag


def rule(command: str) -> str | None:
    found = nudge(command)
    return found[0] if found else None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("git log", "unbounded-log"),
        ("git -C /repo log --stat", "unbounded-log"),
        ("ls -laR /etc", "recursive-ls"),
        ("grep -r retry ~/.claude/projects/", "transcript-grep"),
        ("rg foo session.jsonl | head -20", "transcript-grep"),
        ("python3 -c 'import json,sys; print(json.load(sys.stdin)[\"a\"])'", "python-json"),
    ],
)
def test_an_unbounded_command_is_nudged(command, expected):
    assert rule(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        "git log -n 20 --oneline",
        "git log --oneline -5",
        "git log origin/main..HEAD",
        "git log --since=2.days",
        "git log | head -30",
        "ls -R src | wc -l",
        "ls -la",
        "grep -r retry ~/.claude/projects/ | cut -c1-200",
        "grep -r retry src/",
        "python3 -c 'print(1 + 1)'",
        "python3 script.py data.json",
    ],
)
def test_a_bounded_command_is_left_alone(command):
    assert rule(command) is None


def test_an_unreadable_command_gets_no_nudge():
    assert nudge("git log 'unterminated") is None


def test_seen_reads_the_tag_from_the_transcript(tmp_path):
    transcript = tmp_path / "t.jsonl"
    transcript.write_text(json.dumps({"content": [f"{tag('unbounded-log')} x"]}) + "\n")
    assert seen(str(transcript), "unbounded-log")
    assert not seen(str(transcript), "recursive-ls")
    assert not seen(str(tmp_path / "missing.jsonl"), "unbounded-log")


def test_a_nudge_alone_is_additional_context_with_no_decision():
    out = json.loads(pre_tool_use_json(NONE, "[claude-guard:nudge:x] bound it"))
    assert out == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "[claude-guard:nudge:x] bound it",
        }
    }


def test_a_nudge_rides_beside_an_allow():
    out = json.loads(pre_tool_use_json(Verdict("allow", "readonly", ""), "n"))
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert out["hookSpecificOutput"]["additionalContext"] == "n"


def test_a_deny_carries_no_nudge():
    out = json.loads(pre_tool_use_json(Verdict("deny", "r", "no"), "n"))
    assert "additionalContext" not in out["hookSpecificOutput"]


def test_the_hook_nudges_once_per_session(tmp_path):
    from claude_guard.hook import nudge_for

    transcript = tmp_path / "t.jsonl"
    transcript.write_text("{}\n")
    stdin = json.dumps({"tool_input": {"command": "git log"}, "transcript_path": str(transcript)})
    first = nudge_for("git log", stdin)
    assert first and first.startswith(tag("unbounded-log"))
    # The harness records additionalContext in the transcript; simulate that.
    transcript.write_text(json.dumps({"attachment": {"content": [first]}}) + "\n")
    assert nudge_for("git log", stdin) is None


def test_a_subagent_reads_its_own_transcript_for_the_once_rule(tmp_path):
    from claude_guard.hook import context_transcript, nudge_for

    parent = tmp_path / "sess.jsonl"
    parent.write_text(json.dumps({"content": [f"{tag('unbounded-log')} x"]}) + "\n")
    payload = {"transcript_path": str(parent), "agent_id": "a1"}
    own = tmp_path / "sess" / "subagents" / "agent-a1.jsonl"
    assert context_transcript(payload) == str(own)
    # The parent saw the nudge, the subagent has not: the subagent still gets it.
    stdin = json.dumps({"tool_input": {"command": "git log"}, **payload})
    assert nudge_for("git log", stdin)
    own.parent.mkdir(parents=True)
    own.write_text(json.dumps({"content": [f"{tag('unbounded-log')} x"]}) + "\n")
    assert nudge_for("git log", stdin) is None
