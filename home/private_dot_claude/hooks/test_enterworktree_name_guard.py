#!/usr/bin/env python3
"""Standalone tests for enterworktree-name-guard.py.

Run: python3 test_enterworktree_name_guard.py

Feeds the hook a PreToolUse EnterWorktree payload on stdin and asserts deny vs no
decision.
"""

import json
import os
import subprocess
import sys

from _testkit import check, finish

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_enterworktree-name-guard.py")
if not os.path.exists(HOOK):
    HOOK = os.path.join(
        HERE, "enterworktree-name-guard.py"
    )  # deployed tree, prefix stripped


def run_hook(tool_input, prefix=None, raw=None):
    """Return (decision, reason): ('deny', text) or (None, '')."""
    env = dict(os.environ)
    env.pop("CLAUDE_WORKTREE_PREFIX", None)
    if prefix:
        env["CLAUDE_WORKTREE_PREFIX"] = prefix
    payload = (
        raw
        if raw is not None
        else json.dumps({"tool_name": "EnterWorktree", "tool_input": tool_input})
    )
    p = subprocess.run(
        [sys.executable, HOOK], input=payload, capture_output=True, text=True, env=env
    )
    if not p.stdout.strip():
        return None, ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


decision, reason = run_hook({})
check("a call with no name is denied", decision == "deny")
check("the denial asks for a name", 'name: "<slug>"' in reason)

check("a blank name is denied", run_hook({"name": "  "})[0] == "deny")

check("a named call passes", run_hook({"name": "claim-labels"}) == (None, ""))
check(
    "a path-only call into an existing worktree passes",
    run_hook({"path": "/repo/.claude/worktrees/claim-labels"}) == (None, ""),
)

_, prefixed = run_hook({}, prefix="claude")
check(
    "the agent user is asked for its prefixed form", 'name: "claude/<slug>"' in prefixed
)

check("unreadable input fails open", run_hook({}, raw="not json") == (None, ""))

finish()
