#!/usr/bin/env python3
"""Standalone tests for repeat-failure-guard.py.

Run: python3 test_repeat_failure_guard.py

Feeds the hook PostToolUseFailure payloads on stdin, with its state directory in a
temporary directory, and asserts when it returns stop-and-report context.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

from _testkit import check, finish

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_repeat-failure-guard.py")
if not os.path.exists(HOOK):
    HOOK = os.path.join(
        HERE, "repeat-failure-guard.py"
    )  # deployed tree, prefix stripped

STATE = tempfile.mkdtemp(prefix="repeat-failure-test-")
WORKTREE = {"path": "/home/ubuntu/server/.claude/worktrees/operations-docs"}


def run_hook(
    tool_input=None, tool="EnterWorktree", prompt="p1", session="s1", raw=None, **extra
):
    """Return the additionalContext the hook printed, or '' when it printed nothing."""
    payload = {
        "session_id": session,
        "prompt_id": prompt,
        "hook_event_name": "PostToolUseFailure",
        "tool_name": tool,
        "tool_input": WORKTREE if tool_input is None else tool_input,
        "error": "WorktreeIsolationError",
        **extra,
    }
    env = dict(os.environ, REPEAT_FAILURE_STATE_DIR=STATE)
    p = subprocess.run(
        [sys.executable, HOOK],
        input=raw if raw is not None else json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
    )
    if not p.stdout.strip():
        return ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    assert out["hookEventName"] == "PostToolUseFailure"
    return out["additionalContext"]


check("a first failure draws no context", run_hook() == "")
second = run_hook()
check("a second identical EnterWorktree failure draws stop context", "Stop" in second)
check("the context names the tool and the count", "failure 2 of" in second)
check("the context asks for a report", "Report the failure" in second)
check("a third repeat still draws it, counted", "failure 3 of" in run_hook())

check(
    "a call with different input is a different call",
    run_hook({"name": "operations-docs"}, session="s2") == ""
    and run_hook({"path": "/elsewhere"}, session="s2") == "",
)
check(
    "the same input to another tool is a different call",
    run_hook(session="s3") == "" and run_hook(tool="Bash", session="s3") == "",
)
check(
    "input key order does not change the call's identity",
    run_hook({"a": 1, "b": 2}, session="s4") == ""
    and "Stop" in run_hook({"b": 2, "a": 1}, session="s4"),
)

run_hook(session="s5", prompt="turn-1")
check(
    "a new prompt starts a new turn's count",
    run_hook(session="s5", prompt="turn-2") == "",
)
check(
    "sessions do not share counts",
    run_hook(session="s6") == "" and run_hook(session="s7") == "",
)

run_hook(session="s8", is_interrupt=True)
check(
    "an interrupt is not counted",
    run_hook(session="s8", is_interrupt=True) == "" and run_hook(session="s8") == "",
)

check(
    "a session id that is not a plain token writes nothing",
    run_hook(session="../escape") == ""
    and run_hook(session="../escape") == ""
    and not os.path.exists(os.path.join(os.path.dirname(STATE), "escape.json")),
)

stale = os.path.join(STATE, "old-session.json")
with open(stale, "w") as fh:
    fh.write("{}")
os.utime(stale, (time.time() - 3 * 24 * 3600,) * 2)
run_hook(session="s9")
check("a session file older than two days is pruned", not os.path.exists(stale))

check("unreadable input fails open", run_hook(raw="not json") == "")

finish()
