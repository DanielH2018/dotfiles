"""The PreToolUse and PermissionRequest payload, parsed once at the hook boundary.

`parse()` reads the hook's stdin JSON into a `PreToolUseEvent`, and every check takes that
event or one of its fields. A field that is absent, empty or of the wrong type becomes None
here, so no check re-tests the payload's shape. That matters most for `cwd`: an empty
string handed on as a directory makes `git -C ""` probe the hook process's own directory,
and None cannot be passed as one by accident.

Typical usage example:

  event = parse(stdin_text)
  if event is None or event.bash is None:
      return None
  decision = hook.decide(event.bash.command, event.cwd, env, event.agent_id)
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class BashInput:
    """A tool input that carries a shell command.

    Attributes:
      command: the command text.
      run_in_background: whether the caller asked to background the call.
      timeout: the call's timeout in milliseconds, or None when it is absent or not an int.
      disable_sandbox: whether `dangerouslyDisableSandbox` is exactly `true`.
    """

    command: str
    run_in_background: bool
    timeout: int | None
    disable_sandbox: bool


@dataclass(frozen=True)
class PreToolUseEvent:
    """One hook call's payload.

    Attributes:
      tool_name: the tool being called, or None.
      tool_input: the tool input as sent, or {} when it is not an object. A rewrite
        spreads it into `updatedInput`, because Claude Code replaces the input rather
        than merging into it.
      bash: the command input, or None when `tool_input` has no string `command`. It is
        read whatever `tool_name` says, so the deny rules judge a payload with no tool
        name; `is_bash` adds the tool-name check.
      cwd: the session's working directory, or None.
      agent_id: the calling subagent's id, or None for the main session.
      agent_type: the calling subagent's frontmatter `name:`, or None.
      permission_mode: the session's permission mode, or None.
      transcript_path: the session transcript, or None.
      tool_use_id: the call's id, or None.
    """

    tool_name: str | None
    tool_input: Mapping
    bash: BashInput | None
    cwd: str | None
    agent_id: str | None
    agent_type: str | None
    permission_mode: str | None
    transcript_path: str | None
    tool_use_id: str | None

    @property
    def is_bash(self) -> bool:
        """Whether this is a Bash tool call with a command."""
        return self.tool_name == "Bash" and self.bash is not None


def _text(data: Mapping, key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) and value else None


def _bash(tool_input: Mapping) -> BashInput | None:
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    timeout = tool_input.get("timeout")
    return BashInput(
        command=command,
        run_in_background=bool(tool_input.get("run_in_background")),
        timeout=timeout if isinstance(timeout, int) else None,
        disable_sandbox=tool_input.get("dangerouslyDisableSandbox") is True,
    )


def parse(stdin_text: str) -> PreToolUseEvent | None:
    """The event in `stdin_text`, or None when it is not JSON or not an object.

    Never raises on any string, nesting too deep to decode included."""
    try:
        data = json.loads(stdin_text)
    except ValueError, RecursionError:
        return None
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    return PreToolUseEvent(
        tool_name=_text(data, "tool_name"),
        tool_input=tool_input,
        bash=_bash(tool_input),
        cwd=_text(data, "cwd"),
        agent_id=_text(data, "agent_id"),
        agent_type=_text(data, "agent_type"),
        permission_mode=_text(data, "permission_mode"),
        transcript_path=_text(data, "transcript_path"),
        tool_use_id=_text(data, "tool_use_id"),
    )
