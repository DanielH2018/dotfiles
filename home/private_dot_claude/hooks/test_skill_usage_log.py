#!/usr/bin/env python3
"""Standalone tests for skill-usage-log.sh.

Run: python3 test_skill_usage_log.py

The hook's job is a fire-count register: one JSONL line per Skill/Agent tool call, and
silence for everything else. Both directions are pinned, and the silent one matters
more -- this hook sits in the PostToolUse chain for the single most common tool
(Bash lands in the same matcher list), so a spurious write there would run on
practically every tool call in every session.

Also pins the two things a fire count is actually built out of: which field carries
the name for each kind (tool_input.skill for Skill, tool_input.subagent_type for
Agent/Task), and that "Task" is accepted as an alias for "Agent" -- the harness has
used both spellings for the subagent-dispatch tool across versions (see
log-permission.js in vault-tooling/claude-audit-portable), so a hook that only
matched one would silently stop logging agent dispatches the next time it changes
back.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOOK = HERE / "executable_skill-usage-log.sh"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "skill-usage-log.sh"

# Scrub git's own environment: the hook shells out to `git -C <cwd> rev-parse
# --git-common-dir` to resolve cwd_repo, and GIT_DIR/GIT_WORK_TREE outrank -C.
for _var in [k for k in os.environ if k.startswith("GIT_")]:
    del os.environ[_var]

failures = []
ran = 0


def check(name, condition):
    global ran
    ran += 1
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def run_hook(payload, home_dir, cwd):
    env = {**os.environ, "HOME": str(home_dir)}
    subprocess.run(
        ["bash", str(HOOK)],
        cwd=str(cwd),
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def log_lines(home_dir):
    log = Path(home_dir) / ".claude" / "logs" / "skill-usage.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)

    # ── red-proof pair ───────────────────────────────────────────────────────────────

    home1 = root / "home-skill"
    home1.mkdir()
    run_hook(
        {
            "session_id": "s1",
            "cwd": str(root),
            "tool_name": "Skill",
            "tool_input": {"skill": "chezmoi-repo-ops"},
        },
        home1,
        root,
    )
    lines = log_lines(home1)
    check("a Skill event writes exactly one line", len(lines) == 1)
    check(
        "the written line has kind=skill and the skill name",
        bool(lines)
        and lines[0].get("kind") == "skill"
        and lines[0].get("name") == "chezmoi-repo-ops",
    )

    home2 = root / "home-bash"
    home2.mkdir()
    run_hook(
        {
            "session_id": "s2",
            "cwd": str(root),
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        },
        home2,
        root,
    )
    check("a Bash event writes nothing", log_lines(home2) == [])

    # ── name extraction, both kinds ─────────────────────────────────────────────────

    home3 = root / "home-agent"
    home3.mkdir()
    run_hook(
        {
            "session_id": "s3",
            "cwd": str(root),
            "tool_name": "Agent",
            "tool_input": {"subagent_type": "chore", "description": "rename a var"},
        },
        home3,
        root,
    )
    lines = log_lines(home3)
    check(
        "an Agent event extracts subagent_type as the name, kind=agent",
        bool(lines)
        and lines[0].get("kind") == "agent"
        and lines[0].get("name") == "chore",
    )

    home4 = root / "home-task-alias"
    home4.mkdir()
    run_hook(
        {
            "session_id": "s4",
            "cwd": str(root),
            "tool_name": "Task",
            "tool_input": {"subagent_type": "deep-review"},
        },
        home4,
        root,
    )
    lines = log_lines(home4)
    check(
        "a Task event (the legacy tool_name) is accepted as an agent dispatch too",
        bool(lines)
        and lines[0].get("kind") == "agent"
        and lines[0].get("name") == "deep-review",
    )

    home5 = root / "home-skill-fallback"
    home5.mkdir()
    run_hook(
        {
            "session_id": "s5",
            "cwd": str(root),
            "tool_name": "Skill",
            "tool_input": {"command": "artifact-design"},
        },
        home5,
        root,
    )
    lines = log_lines(home5)
    check(
        "a Skill event with no `skill` field falls back to `command`",
        bool(lines) and lines[0].get("name") == "artifact-design",
    )

    # ── ok reflects tool_response.is_error, IF the payload carries it ──────────────
    # This pins the hook's own mapping (is_error:true -> ok:false), not a confirmed
    # harness contract -- no sampled PostToolUse payload was found carrying
    # tool_response.is_error for Skill/Agent. If the harness never sets it, `ok` is
    # `true` for every row and this case just never fires in production.

    home6 = root / "home-error"
    home6.mkdir()
    run_hook(
        {
            "session_id": "s6",
            "cwd": str(root),
            "tool_name": "Skill",
            "tool_input": {"skill": "gh-stack"},
            "tool_response": {"is_error": True},
        },
        home6,
        root,
    )
    lines = log_lines(home6)
    check(
        "tool_response.is_error=true is recorded as ok=false",
        bool(lines) and lines[0].get("ok") is False,
    )

print()
if failures:
    print(f"{len(failures)} failure(s): {', '.join(failures)}")
    raise SystemExit(1)
print(f"OK {ran}")
