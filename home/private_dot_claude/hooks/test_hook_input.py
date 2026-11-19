#!/usr/bin/env python3
"""Standalone tests for hook_input.py.

Run: python3 test_hook_input.py

read_event() touches the real stdin, so those cases run a
child interpreter with lib/ on sys.path, the way a hook imports the module.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

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
check(
    "parse_event keeps a valid empty object as an event",
    hook_input.parse_event("{}") is not None,
)
check(
    "parse_event fails open on nesting too deep to decode",
    hook_input.parse_event("[" * 100_000) is None,
)

event = hook_input.parse_event(
    json.dumps(
        {
            "session_id": "s1",
            "tool_name": "Bash",
            "cwd": "/w/repo",
            "transcript_path": "/t/s.jsonl",
            "tool_input": {"command": "ls"},
            "tool_response": {"is_error": False},
            "prompt_id": "p1",
        }
    )
)
check(
    "parse_event types the common fields",
    event is not None
    and (event.session_id, event.tool_name) == ("s1", "Bash")
    and (event.cwd, event.transcript_path) == (Path("/w/repo"), Path("/t/s.jsonl"))
    and event.tool_input == {"command": "ls"}
    and event.tool_response == {"is_error": False},
)
check(
    "parse_event keeps the raw payload",
    event is not None and event.raw["prompt_id"] == "p1",
)

for value in [None, "", 5, "relative/dir"]:
    fields = {} if value is None else {"cwd": value, "transcript_path": value}
    event = hook_input.parse_event(json.dumps(fields))
    check(
        f"a cwd or transcript_path of {value!r} is None",
        event is not None and event.cwd is None and event.transcript_path is None,
    )
event = hook_input.parse_event(json.dumps({"transcript_path": "~/t/s.jsonl"}))
check(
    "transcript_path expands ~",
    event is not None and event.transcript_path == Path.home() / "t" / "s.jsonl",
)
for value in [None, "", 5]:
    event = hook_input.parse_event(
        json.dumps({"session_id": value, "tool_name": value})
    )
    check(
        f"a session_id or tool_name of {value!r} is None",
        event is not None and event.session_id is None and event.tool_name is None,
    )
for value in [None, "ls", ["ls"]]:
    event = hook_input.parse_event(
        json.dumps({"tool_input": value, "tool_response": value})
    )
    check(
        f"a tool_input of {value!r} is {{}} and a tool_response is None",
        event is not None and event.tool_input == {} and event.tool_response is None,
    )

p = child("print(hook_input.read_event().cwd)", stdin='{"cwd": "/x"}')
check("read_event parses stdin", p.stdout.strip() == "/x")
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

finish()
