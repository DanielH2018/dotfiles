#!/usr/bin/env python3
# gen-hooks: register
#   event: PostToolUseFailure
#   timeout: 5
#   order: 50
"""PostToolUseFailure hook: stop a session after a second identical failure in a turn.

A session that repeats one failing call spins rather than corrects. On 2026-10-10 one
turn called `EnterWorktree` ten times with the same `path`, and all ten failed with
`WorktreeIsolationError` (dotfiles#838). The user-level CLAUDE.md said "retry once",
but that rule was prose, and nothing counted the failures.

This hook counts them. It keys each failure on the tool name and a hash of the tool's
input, and it scopes the count to one turn: `prompt_id` names the user prompt being
processed, so the count resets when the next prompt arrives. At the second failure
with the same key, it returns `additionalContext` telling the model to stop retrying
that call and report the failure. Every later repeat gets the same context, with
the count. A call whose input differs, even by one character, is a different call, so
a corrected retry is never flagged.

An interrupt (`is_interrupt`) is not a failure the model caused, so it is not counted.

State is one small JSON file per session under
`${XDG_STATE_HOME:-~/.local/state}/claude/repeat-failure/`, holding only the current
turn's counts. Each write deletes the session files more than two days old, so the
directory does not grow.

Fails open: unreadable input or an unwritable state directory prints nothing.
"""

import fcntl
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import hook_input

THRESHOLD = 2
STALE_SECONDS = 2 * 24 * 3600


def state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(
        os.path.expanduser("~"), ".local", "state"
    )
    return Path(
        os.environ.get("REPEAT_FAILURE_STATE_DIR")
        or os.path.join(base, "claude", "repeat-failure")
    )


def call_key(tool_name: str, tool_input) -> str:
    """The identity of a call: its tool and a hash of its canonical input."""
    canonical = json.dumps(tool_input, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode()).hexdigest()[:16]
    return f"{tool_name}:{digest}"


def record(path: Path, prompt_id: str, key: str) -> int:
    """Count this failure in the session's state file and return the new count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a+", encoding="utf-8") as fh:
        # Parallel tool calls in one turn can fail at the same moment.
        fcntl.flock(fh, fcntl.LOCK_EX)
        fh.seek(0)
        try:
            state = json.loads(fh.read() or "{}")
        except json.JSONDecodeError:
            state = {}
        if not isinstance(state, dict) or state.get("prompt_id") != prompt_id:
            state = {"prompt_id": prompt_id, "counts": {}}
        counts = state.setdefault("counts", {})
        counts[key] = int(counts.get(key, 0)) + 1
        fh.seek(0)
        fh.truncate()
        json.dump(state, fh)
        return counts[key]


def prune(directory: Path, keep: Path) -> None:
    cutoff = time.time() - STALE_SECONDS
    for entry in directory.glob("*.json"):
        try:
            if entry != keep and entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            pass


def message(tool_name: str, count: int) -> str:
    return (
        f"This is failure {count} of an identical `{tool_name}` call in this turn: "
        "the same input failed before. Retrying it unchanged will not succeed. "
        "Stop calling it with this input. Report the failure to the user with the "
        "error text verbatim, and say what you would need to proceed. Change the "
        "input only if the error names a specific fix."
    )


def main() -> int:
    payload = hook_input.read_event()
    if payload is None or payload.get("is_interrupt"):
        return 0
    tool_name = str(payload.get("tool_name") or "")
    session = str(payload.get("session_id") or "")
    # A session id names the state file, so anything but a plain token is refused
    # rather than allowed to aim the write elsewhere.
    if not tool_name or not re.fullmatch(r"[A-Za-z0-9_-]+", session):
        return 0
    key = call_key(tool_name, payload.get("tool_input"))
    directory = state_dir()
    path = directory / f"{session}.json"
    try:
        count = record(path, str(payload.get("prompt_id") or ""), key)
        prune(directory, path)
    except OSError:
        return 0
    if count >= THRESHOLD:
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUseFailure",
                    "additionalContext": message(tool_name, count),
                }
            },
            sys.stdout,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
