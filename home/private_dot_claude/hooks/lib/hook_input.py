"""The Python counterpart to hook-input.sh: read a hook's stdin payload, fail open.

hook-input.sh reads the payload once and hands back an empty field when jq is missing
or the payload does not parse. A Python hook has no jq dependency, so the only failure
left is the payload itself: empty stdin, text that is not JSON, or JSON that is not an
object. read_event() returns None for all three, and the hook exits 0 with no output.

None is kept apart from a valid `{}` on purpose. enterworktree-name-guard.py defaults
`tool_name` to EnterWorktree, so a `{}` there is a nameless call and is denied. If
garbage on stdin also read as `{}`, the guard would deny on its own parse failure
instead of failing open.

Each hook puts lib/ beside itself first on sys.path and imports this module from
there. That holds in the source tree, where hooks run as executable_*.py, and in
~/.claude/hooks, where chezmoi strips the prefix. A single-file `chezmoi apply` of a
hook without this module raises ImportError, so apply the hooks directory as a whole.

Typical usage example:

  event = read_event()
  if event is None:
      return 0
  command = tool_input(event).get("command") or ""
  ...
  emit_decision("deny", reason)
"""

from __future__ import annotations

import json
import sys

DECISIONS = ("allow", "deny", "ask")


def parse_event(text: str) -> dict | None:
    """Parse a hook payload; None when it is empty, not JSON, or not an object.

    Exposed apart from read_event() for a hook that reads stdin on its own terms, such
    as prune-worktrees.py, which waits on stdin with a timeout.
    """
    try:
        event = json.loads(text)
    except ValueError:
        return None
    return event if isinstance(event, dict) else None


def read_event() -> dict | None:
    """Read and parse the hook payload from stdin; see parse_event() for the None cases.

    Read only once per process: a pipe gives up its bytes once, and a second read
    returns empty. An unreadable or undecodable stdin is also None.
    """
    try:
        text = sys.stdin.read()
    except (OSError, ValueError):
        return None
    return parse_event(text)


def tool_input(event: dict) -> dict:
    """Return the event's `tool_input` object, or {} when absent or not an object."""
    value = event.get("tool_input")
    return value if isinstance(value, dict) else {}


def emit_decision(decision: str, reason: str = "") -> None:
    """Write a PreToolUse permission decision to stdout.

    Args:
      decision: One of "allow", "deny" or "ask".
      reason: The permissionDecisionReason. Omitted from the output when empty, which
        is the usual form for "allow".

    Raises:
      ValueError: decision is not one of DECISIONS. A typo must not print a decision
        the harness silently ignores.
    """
    if decision not in DECISIONS:
        raise ValueError(f"unknown permission decision: {decision!r}")
    output = {"hookEventName": "PreToolUse", "permissionDecision": decision}
    if reason:
        output["permissionDecisionReason"] = reason
    json.dump({"hookSpecificOutput": output}, sys.stdout)
    sys.stdout.write("\n")
