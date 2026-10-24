"""The headless permission prompt: claude-guard's allow path for a session with no approver.

A `claude -p` session opens no permission dialog, so the PermissionRequest hook never runs
there, and every `ask` (a settings ask rule or a hook's ask) ends as "you haven't granted it
yet". Claude Code's `--permission-prompt-tool` names an MCP tool to call instead. This module
is that tool: `claude-guard prompt-server` serves it over stdio as `decide`, and the launcher
passes `--mcp-config` naming the server plus `--permission-prompt-tool
mcp__claude-guard__decide`.

The tool allows exactly what `hook.permission_request` allows, by calling the same
`hook.decide`, and denies everything else: another tool, a command the judge has no opinion
on, a malformed request, any exception. Measured 2026-10-24 in a headless auto-mode session:
the tool is consulted for a settings ask rule and for a hook's ask, never after a hook's deny.
So a hook deny still wins, and a hook ask is answered as the PermissionRequest hook answers it
in an interactive session.

The request carries `tool_name`, `input` and `tool_use_id`, but no working directory, and
the judge needs one to vet a worktree-relative `rm` or a `git reset`. So the PreToolUse arm,
which sees the payload's `cwd`, records it per `tool_use_id` (`record_context`), with the
environment values the judge reads. `decide` reads and deletes that record. With no record it
judges with cwd "" and the server's own environment, and every cwd-dependent check refuses
on an empty cwd (`hook.read_cwd`), so a missing record narrows what is allowed and never
widens it.
"""

import json
import os
import re
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import IO

SERVER_NAME = "claude-guard"
TOOL_NAME = "decide"
# The environment values `hook.decide` reads, recorded from the hook's environment because
# the MCP server is not guaranteed to inherit the session's (CLAUDE_PROJECT_DIR is set for
# hooks).
CONTEXT_ENV = ("HOME", "TMPDIR", "CLAUDE_PROJECT_DIR", "CLAUDE_JOB_DIR")
# A record older than this is a call that never prompted; it is pruned on the next write.
MAX_AGE_S = 3600
_TOOL_USE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

DENY_MESSAGE = (
    "claude-guard: this headless session has no interactive approver, and no claude-guard "
    "rule allows this call, so it is refused. Reshape the command into a form the allow "
    "rules accept (an rm confined to the worktree or a scratch root, one command per call, "
    "`git -C <dir>` rather than `cd <dir> && git`), or report it for the operator to run."
)


def context_dir(env: Mapping[str, str]) -> Path:
    """Where the per-call records live: `~/.cache/claude-guard/tool-context`."""
    return (
        Path(env.get("HOME") or os.path.expanduser("~"))
        / ".cache"
        / "claude-guard"
        / "tool-context"
    )


def record_context(stdin_text: str, env: Mapping[str, str], now: float | None = None) -> None:
    """Record this Bash call's cwd and judge environment under its `tool_use_id`.

    Called from the PreToolUse arm on every Bash call. Never raises: a failure here only
    means a later prompt is judged without a cwd, which refuses more."""
    try:
        data = json.loads(stdin_text)
        if not isinstance(data, dict) or data.get("tool_name") != "Bash":
            return
        tool_use_id = data.get("tool_use_id")
        cwd = data.get("cwd")
        if not isinstance(tool_use_id, str) or not _TOOL_USE_ID.match(tool_use_id):
            return
        if not isinstance(cwd, str):
            return
        d = context_dir(env)
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(d, 0o700)
        now = time.time() if now is None else now
        for old in d.iterdir():
            try:
                if now - old.stat().st_mtime > MAX_AGE_S:
                    old.unlink()
            except OSError:
                pass
        body = {"cwd": cwd, "env": {k: env[k] for k in CONTEXT_ENV if env.get(k)}}
        tmp = d / f".{tool_use_id}.tmp"
        tmp.write_text(json.dumps(body))
        tmp.replace(d / f"{tool_use_id}.json")
    except Exception:
        return


def take_context(tool_use_id: object, env: Mapping[str, str]) -> tuple[str, dict[str, str]]:
    """The recorded (cwd, env values) for `tool_use_id`, deleting the record, or ("", {})."""
    if not isinstance(tool_use_id, str) or not _TOOL_USE_ID.match(tool_use_id):
        return "", {}
    path = context_dir(env) / f"{tool_use_id}.json"
    try:
        body = json.loads(path.read_text())
        path.unlink()
    except OSError, ValueError:
        return "", {}
    cwd = body.get("cwd") if isinstance(body, dict) else None
    saved = body.get("env") if isinstance(body, dict) else None
    if not isinstance(cwd, str) or not isinstance(saved, dict):
        return "", {}
    return cwd, {k: v for k, v in saved.items() if k in CONTEXT_ENV and isinstance(v, str)}


def decide(arguments: object, env: Mapping[str, str]) -> dict:
    """The prompt verdict for one request: allow with the input unchanged, or deny.

    Allows only a Bash call whose command `hook.decide` allows, judged in the recorded cwd
    and environment. Every other case, an exception included, is a deny."""
    # Imported here: hook imports this module for record_context.
    from claude_guard import hook

    deny = {"behavior": "deny", "message": DENY_MESSAGE}
    try:
        if not isinstance(arguments, dict) or arguments.get("tool_name") != "Bash":
            return deny
        tool_input = arguments.get("input")
        if not isinstance(tool_input, dict):
            return deny
        command = tool_input.get("command")
        if not isinstance(command, str) or not command.strip():
            return deny
        cwd, saved = take_context(arguments.get("tool_use_id"), env)
        decision = hook.decide(command, cwd, {**env, **saved})
        if decision.allow:
            return {"behavior": "allow", "updatedInput": tool_input}
        return deny
    except Exception:
        return deny


_TOOL_SCHEMA = {
    "name": TOOL_NAME,
    "description": "Answers a Claude Code permission prompt with claude-guard's allow rules.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "tool_name": {"type": "string"},
            "input": {"type": "object"},
            "tool_use_id": {"type": "string"},
        },
        "additionalProperties": True,
    },
}


def handle(msg: object, env: Mapping[str, str]) -> dict | None:
    """The JSON-RPC response to one MCP message, or None for a notification."""
    if not isinstance(msg, dict):
        return None
    mid = msg.get("id")
    method = msg.get("method")
    if mid is None:
        return None
    params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
    if method == "initialize":
        result: dict = {
            "protocolVersion": params.get("protocolVersion") or "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": "1"},
        }
    elif method == "tools/list":
        result = {"tools": [_TOOL_SCHEMA]}
    elif method == "tools/call":
        if params.get("name") != TOOL_NAME:
            verdict = {"behavior": "deny", "message": DENY_MESSAGE}
        else:
            verdict = decide(params.get("arguments"), env)
        result = {"content": [{"type": "text", "text": json.dumps(verdict)}]}
    elif method == "ping":
        result = {}
    else:
        return {
            "jsonrpc": "2.0",
            "id": mid,
            "error": {"code": -32601, "message": f"method not found: {method}"},
        }
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def serve(stdin: IO[str], stdout: IO[str], env: Mapping[str, str]) -> int:
    """Answer newline-delimited JSON-RPC on `stdin` until it closes."""
    for line in stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        reply = handle(msg, env)
        if reply is not None:
            stdout.write(json.dumps(reply) + "\n")
            stdout.flush()
    return 0


def main() -> int:
    return serve(sys.stdin, sys.stdout, os.environ)
