#!/usr/bin/env python3
"""Standalone tests for hook_input.py.

Run: python3 test_hook_input.py

read_event() and emit_decision() touch the real stdin and stdout, so those cases run a
child interpreter with lib/ on sys.path, the way a hook imports the module.
"""

import json
import os
import subprocess
import sys

from _testkit import check, finish

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
sys.path.insert(0, LIB)

import hook_input  # noqa: E402


def child(code, stdin=""):
    return subprocess.run(
        [sys.executable, "-c", f"import hook_input\n{code}"],
        input=stdin,
        capture_output=True,
        text=True,
        cwd=LIB,
    )


for raw in ["", "   ", "not json", "[]", '"str"', "42", "null"]:
    check(f"parse_event fails open on {raw!r}", hook_input.parse_event(raw) is None)
check("parse_event keeps a valid empty object", hook_input.parse_event("{}") == {})
check(
    "parse_event returns the payload object",
    hook_input.parse_event('{"tool_name": "Bash"}') == {"tool_name": "Bash"},
)

p = child("print(hook_input.read_event())", stdin='{"cwd": "/x"}')
check("read_event parses stdin", p.stdout.strip() == "{'cwd': '/x'}")
p = child("print(hook_input.read_event())", stdin="garbage")
check(
    "read_event fails open on garbage stdin",
    p.returncode == 0 and p.stdout.strip() == "None" and not p.stderr,
)
p = subprocess.run(
    [sys.executable, "-c", "import hook_input; print(hook_input.read_event())"],
    stdin=subprocess.DEVNULL,
    capture_output=True,
    text=True,
    cwd=LIB,
)
check("read_event fails open on empty stdin", p.stdout.strip() == "None")

check(
    "tool_input returns the tool_input object",
    hook_input.tool_input({"tool_input": {"command": "ls"}}) == {"command": "ls"},
)
for value in [None, "ls", ["ls"]]:
    check(
        f"tool_input coerces {value!r} to {{}}",
        hook_input.tool_input({"tool_input": value}) == {},
    )
check("tool_input of an event without one is {}", hook_input.tool_input({}) == {})

# A reason carrying a quote and a newline must survive as one JSON string.
p = child('hook_input.emit_decision("deny", \'no "x"\\nhere\')')
out = json.loads(p.stdout)["hookSpecificOutput"]
check(
    "emit_decision writes a PreToolUse deny with its reason",
    out
    == {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": 'no "x"\nhere',
    },
)
p = child('hook_input.emit_decision("ask", "check this")')
check(
    "emit_decision writes an ask",
    json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"] == "ask",
)
p = child('hook_input.emit_decision("allow")')
check(
    "emit_decision omits an empty reason",
    "permissionDecisionReason" not in json.loads(p.stdout)["hookSpecificOutput"],
)
p = child('hook_input.emit_decision("block", "x")')
check(
    "emit_decision refuses an unknown decision and prints nothing",
    p.returncode != 0 and p.stdout == "" and "ValueError" in p.stderr,
)

finish()
