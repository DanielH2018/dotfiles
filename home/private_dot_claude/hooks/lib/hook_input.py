"""The Python counterpart to hook-input.sh: read a hook's stdin payload, fail open.

hook-input.sh reads the payload once and hands back an empty field when jq is missing
or the payload does not parse. A Python hook has no jq dependency, so the only failure
left is the payload itself: empty stdin, text that is not JSON, or JSON that is not an
object. read_event() returns None for all three, and the hook exits 0 with no output.

None is kept apart from a valid `{}` on purpose. A guard that fills a missing field with
a default reads `{}` as a real call and may deny it. If garbage on stdin also read as
`{}`, such a guard would deny on its own parse failure instead of failing open.

A payload that parses becomes a HookEvent, whose common fields are typed once here. A
field that is absent, empty or of the wrong type is None, and `cwd` and
`transcript_path` are None unless they name an absolute path, so no hook re-checks them.
A field only one event carries, such as Stop's `last_assistant_message`, is read from
`raw`.

Each hook puts lib/ beside itself first on sys.path and imports this module from
there. That holds in the source tree, where hooks run as executable_*.py, and in
~/.claude/hooks, where chezmoi strips the prefix. A single-file `chezmoi apply` of a
hook without this module raises ImportError, so apply the hooks directory as a whole.

Typical usage example:

  event = read_event()
  if event is None:
      return 0
  command = event.tool_input.get("command") or ""
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HookEvent:
    """One hook call's payload.

    Attributes:
      session_id: the session's id, or None.
      tool_name: the tool being called, or None for an event that names no tool.
      cwd: the session's working directory, or None unless it is absolute.
      transcript_path: the session transcript, `~` expanded, or None unless it is
        absolute.
      tool_input: the tool input, or {} when it is absent or not an object.
      tool_response: the tool's response, or None when it is absent or not an object.
      raw: the whole payload, for the fields only one event carries.
    """

    session_id: str | None
    tool_name: str | None
    cwd: Path | None
    transcript_path: Path | None
    tool_input: Mapping
    tool_response: Mapping | None
    raw: Mapping


def _text(data: dict, key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) and value else None


def _absolute(data: dict, key: str) -> Path | None:
    value = _text(data, key)
    if value is None:
        return None
    path = Path(value).expanduser()
    return path if path.is_absolute() else None


def parse_event(text: str) -> HookEvent | None:
    """Parse a hook payload; None when it is empty, not JSON, or not an object.

    Exposed apart from read_event() for a hook that reads stdin on its own terms, such
    as prune-worktrees.py, which waits on stdin with a timeout.
    """
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        return None
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input")
    tool_response = data.get("tool_response")
    return HookEvent(
        session_id=_text(data, "session_id"),
        tool_name=_text(data, "tool_name"),
        cwd=_absolute(data, "cwd"),
        transcript_path=_absolute(data, "transcript_path"),
        tool_input=tool_input if isinstance(tool_input, dict) else {},
        tool_response=tool_response if isinstance(tool_response, dict) else None,
        raw=data,
    )


def read_event() -> HookEvent | None:
    """Read and parse the hook payload from stdin; see parse_event() for the None cases.

    Read only once per process: a pipe gives up its bytes once, and a second read
    returns empty. An unreadable or undecodable stdin is also None.
    """
    try:
        text = sys.stdin.read()
    except (OSError, ValueError):
        return None
    return parse_event(text)
