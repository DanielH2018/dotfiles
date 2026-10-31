"""The context-discipline nudges (dotfiles #586), the show-substitution nudge, the
gitops-state nudge (dotfiles #1041), and the whole-file-cat nudge (dotfiles #1076).

Each rule has a command it must nudge and a bounded variant it must leave alone. The
hook-level tests pin that a nudge rides beside a verdict, never on a deny, and only once
per session.
"""

import json
import os
import sys

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
        (
            "for f in $(git ls-tree --name-only origin/main w); do git show origin/main:$f; done",
            "show-substitution",
        ),
        ('git show "origin/main:$(git ls-files x | head -1)"', "show-substitution"),
        ("cat /var/lib/gitops-deploy/owed.jsonl", "gitops-state"),
        ("sudo tail -n 5 /var/lib/gitops-deploy/owed.jsonl", "gitops-state"),
        ("ssh daniel-server 'cat /var/lib/gitops-deploy/hold_sha'", "gitops-state"),
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
        "git show origin/main:README.md",
        "f=README.md; git show origin/main:$f",
        "ls -l /var/lib/gitops-deploy/",
        "cat /var/lib/other/hold_sha",
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
    got = context_transcript(payload)
    if sys.platform == "win32":
        # The harness splices a "/" into the path, which Windows spells with a backslash.
        got = os.path.normpath(got)
    assert got == str(own)
    # The parent saw the nudge, the subagent has not: the subagent still gets it.
    stdin = json.dumps({"tool_input": {"command": "git log"}, **payload})
    assert nudge_for("git log", stdin)
    own.parent.mkdir(parents=True)
    own.write_text(json.dumps({"content": [f"{tag('unbounded-log')} x"]}) + "\n")
    assert nudge_for("git log", stdin) is None


@pytest.fixture
def big_and_small(tmp_path):
    (tmp_path / "big.j2").write_text("x" * 30_000)
    (tmp_path / "small.j2").write_text("x" * 1_000)
    return tmp_path


@pytest.mark.parametrize(
    "command",
    [
        "cat -n {d}/big.j2",
        "cat -n big.j2",
        "cd {d}; cat -n big.j2",
        "cat small.j2 big.j2",
        "cat -n big.j2 | sort",
        "cat big.j2 2> /dev/null",
        "cat < big.j2",
        "cat <big.j2",
        "cat 0< big.j2",
    ],
)
def test_an_unbounded_cat_of_a_big_file_is_nudged(big_and_small, command):
    found = nudge(command.format(d=big_and_small), cwd=str(big_and_small))
    assert found and found[0] == "whole-file-cat"


@pytest.mark.parametrize(
    "command",
    [
        "cat -n small.j2",
        "cat < small.j2",
        "cat -n big.j2 | head -50",
        "cat big.j2 | sed -n 10,40p",
        "cat big.j2 | rg -n listen",
        "cat small.j2 big.j2 > joined.j2",
        "cat big.j2 small.j2>>joined.j2",
        "cat missing.j2",
    ],
)
def test_a_small_bounded_or_redirected_cat_is_left_alone(big_and_small, command):
    assert nudge(command, cwd=str(big_and_small)) is None


def test_a_relative_cat_without_a_cwd_is_left_alone(big_and_small):
    assert nudge("cat big.j2") is None


def test_the_hook_resolves_cat_against_the_session_cwd(big_and_small):
    from claude_guard.hook import nudge_for

    stdin = json.dumps({"tool_input": {"command": "cat big.j2"}, "cwd": str(big_and_small)})
    found = nudge_for("cat big.j2", stdin)
    assert found and found.startswith(tag("whole-file-cat"))
