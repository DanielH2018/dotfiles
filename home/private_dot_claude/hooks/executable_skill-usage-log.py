#!/usr/bin/env python3
# gen-hooks: register
#   event: PostToolUse
#   matcher: Skill|Agent|Task
#   timeout: 10
#   order: 100
# Fire-count logging: nothing recorded which of the skills and agents under
# private_dot_claude/{skills,agents} ever actually fire, so a scaffolding-
# delete-pass had no evidence to weigh a removal against. Both "Agent" and
# "Task" are named in the matcher for the same reason the hook itself checks
# both tool_name spellings -- the harness has used either name for the
# subagent-dispatch tool across versions, and matching only one silently
# stops logging agent dispatches the next time it changes back.
"""PostToolUse hook (Skill|Agent|Task): append one JSONL fire-count record per call.

Nothing recorded which of the skills and agents under
home/private_dot_claude/{skills,agents} ever actually fire, so a scaffolding-delete-
pass had no fire count to weigh a removal against. This is the write side: one line
per skill invocation and per agent dispatch to ~/.claude/logs/skill-usage.jsonl.
bin/skill-usage (repo root) reads the file back into a table.

tool_name is handled as both "Agent" and "Task" because the harness has used both
spellings for the subagent-dispatch tool across versions -- matching only one would
silently stop logging agent dispatches the next time the harness's own name for the
tool changes back.

Never fails the tool call: every failure path below returns 0 with nothing written.
This hook has no verdict to give, so it emits nothing on stdout -- there is nothing
here that is ever could-not-evaluate as opposed to just not written. A missing
lib/hook_input.py is a broken install rather than a bad payload, and its ImportError
exits 1 naming the module.

This was a bash script until 2026-10-22. The record schema is unchanged:
{ts, kind, name, session_id, cwd_repo, ok}, in that key order, one compact line each.
The bash version bounded its git call through lib/run-bounded.sh and exited 1 when that
library was missing (#581); subprocess's own timeout replaces the library, so that exit
path went with it.

No separate OTEL emission here. CLAUDE_CODE_ENABLE_TELEMETRY and
OTEL_LOG_TOOL_DETAILS are both already on in settings.base.json, so every Skill/Agent
tool call already lands in Loki as an event log carrying tool_name and its full
tool_input (skill name / subagent_type) on any host running the claude-otel stack --
see home/claude-otel/README.md. That is a genuinely cheap existing path, not a reason
to skip this file: Loki's retention is 31 days against this file's unbounded history,
daniel-pi carries no exporter at all, and daniel-server/daniel-box route through
their own collector, which is not guaranteed to forward Claude Code's signals
anywhere. skill-usage.jsonl (this file) is the one source bin/skill-usage can rely
on existing on every host; Loki is a bonus query surface on the hosts where it runs.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# The shared modules live in lib/ beside this hook, deployed or in the source tree.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "lib"))
import hook_input  # noqa: E402

# The bounds lib/run-bounded.sh applied to the git call: seconds, and bytes of output
# beyond which the answer counts as unusable.
GIT_TIMEOUT_S = 3
GIT_OUTPUT_CAP = 4096


def text(value) -> str:
    """The string `jq -r` printed for a field, as `$(...)` captured it."""
    if value is None:
        return ""
    if not isinstance(value, str):
        value = json.dumps(value)
    return value.rstrip("\n")


def first(*values):
    """jq's `a // b`: the first value that is neither null nor false."""
    for v in values:
        if v is not None and v is not False:
            return v
    return None


def basename(path: str) -> str:
    """basename(1), which ignores trailing slashes where os.path.basename does not."""
    return os.path.basename(path.rstrip("/")) or ("/" if path.startswith("/") else "")


def cwd_repo(cwd: str) -> str:
    """The repo a worktree belongs to, not its own per-worktree path.

    Fire counts for the same repo accumulate across every worktree and session working
    it. `git rev-parse --git-common-dir` returns one of two shapes, absolute or relative
    to cwd, and both resolve to the shared .git directory whose parent names the repo.
    Any failed lookup falls back to the directory name.
    """
    try:
        out = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--git-common-dir"],
            capture_output=True,
            timeout=GIT_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        out = None
    if (
        out is not None
        and out.returncode == 0
        and 0 < len(out.stdout) <= GIT_OUTPUT_CAP
    ):
        common = out.stdout.decode(errors="surrogateescape").replace("\n", "")
        if not common.startswith("/"):
            common = os.path.join(cwd, common)
        if os.path.isdir(common):
            name = basename(os.path.dirname(os.path.realpath(common)))
            if name:
                return name
    return basename(cwd)


def main() -> int:
    event = hook_input.read_event()
    if event is None:
        return 0
    tool_input = hook_input.tool_input(event)

    tool = text(first(event.get("tool_name")))
    if tool == "Skill":
        kind = "skill"
        name = text(first(tool_input.get("skill"), tool_input.get("command")))
    elif tool in ("Agent", "Task"):
        kind = "agent"
        name = text(first(tool_input.get("subagent_type")))
    else:
        return 0
    if not name:
        return 0

    session_id = text(first(event.get("session_id"), "unknown"))
    cwd = text(first(event.get("cwd")))
    # Best-effort: no PostToolUse payload sampled while writing this carried
    # tool_response.is_error (the field is documented for the SDK's own query result
    # and for a Skill/Agent's own success check, not confirmed on the hook payload). If
    # the harness never sets it here, `ok` is just `true` forever -- decoration, not a
    # signal -- rather than wrong, so it is left in rather than guessed at further.
    response = event.get("tool_response")
    is_error = response.get("is_error") if isinstance(response, dict) else None
    ok = text(first(is_error, False)) != "true"

    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "kind": kind,
        "name": name,
        "session_id": session_id,
        "cwd_repo": cwd_repo(cwd) if cwd else "",
        "ok": ok,
    }
    log_dir = Path.home() / ".claude" / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_dir / "skill-usage.jsonl", "a", encoding="utf-8") as f:
            f.write(
                json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
            )
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
