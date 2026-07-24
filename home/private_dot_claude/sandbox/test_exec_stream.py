#!/usr/bin/env python3
"""Standalone tests for exec-stream.py (run: python3 test_exec_stream.py)."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FILTER = os.path.join(HERE, "exec-stream.py")
if not os.path.exists(FILTER):
    FILTER = os.path.join(HERE, "executable_exec-stream.py")  # source tree, prefix not stripped

BEGIN = "<<<EXEC_RESULT>>>"
END = "<<<END_EXEC_RESULT>>>"


def run_filter(events):
    """Feed a list of stream-json event dicts to the filter; return (rc, stdout, stderr)."""
    stdin = "".join(json.dumps(e) + "\n" for e in events)
    p = subprocess.run(
        [sys.executable, FILTER],
        input=stdin, capture_output=True, text=True,
    )
    return p.returncode, p.stdout, p.stderr


def extract_result(stdout):
    lines = stdout.splitlines()
    assert BEGIN in lines and END in lines, f"delimiters missing in stdout: {stdout!r}"
    return "\n".join(lines[lines.index(BEGIN) + 1:lines.index(END)])


def test_success():
    rc, out, err = run_filter([
        {"type": "system", "subtype": "init", "session_id": "abcd1234", "model": "opus"},
        {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "Working on it"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "ls -la"}},
        ]}},
        {"type": "result", "subtype": "success", "is_error": False,
         "result": "Done: edited foo.py", "num_turns": 3, "total_cost_usd": 0.0123},
    ])
    assert rc == 0, f"expected rc 0, got {rc}"
    assert extract_result(out) == "Done: edited foo.py"
    assert "Working on it" in err, "assistant text should stream to stderr"
    assert "Bash: ls -la" in err, "tool use should be summarized to stderr"
    assert "done" in err.lower()


def test_error_exit():
    rc, out, err = run_filter([
        {"type": "result", "subtype": "error", "is_error": True, "result": "boom"},
    ])
    assert rc == 1, f"is_error should exit 1, got {rc}"
    assert extract_result(out) == "boom"


def test_missing_result_is_error():
    rc, out, err = run_filter([
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}},
    ])
    assert rc == 1, "no result event should exit 1"
    assert extract_result(out) == "", "no result text expected"


def test_malformed_line_tolerated():
    stdin = 'not json\n' + json.dumps(
        {"type": "result", "is_error": False, "result": "ok"}) + "\n"
    p = subprocess.run([sys.executable, FILTER], input=stdin,
                       capture_output=True, text=True)
    assert p.returncode == 0
    assert extract_result(p.stdout) == "ok"


if __name__ == "__main__":
    test_success()
    test_error_exit()
    test_missing_result_is_error()
    test_malformed_line_tolerated()
    print("OK")
