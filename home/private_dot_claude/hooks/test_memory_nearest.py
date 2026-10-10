#!/usr/bin/env python3
"""Standalone tests for memory-nearest.py.

Run: python3 test_memory_nearest.py

The hook runs as a subprocess against a throwaway CLAUDE_CONFIG_DIR holding one project
memory store. The pair that matters is a near-duplicate, which must name the existing
memory, against an unrelated memory, which must print nothing. The rest pins the
silence everywhere the hook should not act.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from _testkit import check, finish

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "executable_memory-nearest.py"
if not SCRIPT.exists():  # deployed copy drops chezmoi's mode prefix
    SCRIPT = HERE / "memory-nearest.py"


def memory(name, description):
    return (
        f"---\nname: {name}\ndescription: {json.dumps(description)}\n"
        "metadata:\n  type: project\n---\n\nBody.\n"
    )


with tempfile.TemporaryDirectory() as tmp:
    config = Path(tmp).resolve() / "config"
    store = config / "projects" / "-home-x-repo" / "memory"
    store.mkdir(parents=True)
    (store / "MEMORY.md").write_text("- [a](a.md)\n")
    (store / "deploy-renders-from-worktree.md").write_text(
        memory(
            "deploy-renders-from-worktree",
            "The deploy script renders manifests from the worktree it runs in, "
            "not from the primary checkout.",
        )
    )
    (store / "authelia-431-is-the-read-buffer.md").write_text(
        memory(
            "authelia-431-is-the-read-buffer",
            "A 431 from Authelia means its server read buffer is too small for the "
            "request headers.",
        )
    )

    def run(path, content, extra_env=None):
        event = {
            "tool_name": "Write",
            "tool_input": {"file_path": str(path), "content": content},
        }
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env={**os.environ, "CLAUDE_CONFIG_DIR": str(config), **(extra_env or {})},
        )

    near = memory(
        "deploy-renders-from-the-worktree-you-run-it-in",
        "The deploy renders the manifests from whichever worktree it runs in, "
        "not the primary checkout.",
    )
    dup = run(store / "deploy-worktree-render.md", near)
    check("a near-duplicate exits 0", dup.returncode == 0)
    try:
        out = json.loads(dup.stdout)["hookSpecificOutput"]
    except (ValueError, KeyError):
        out = {}
    context = out.get("additionalContext", "")
    check(
        "a near-duplicate names the existing memory",
        "deploy-renders-from-worktree" in context,
    )
    check("it leaves the unrelated memory out", "authelia" not in context)
    check(
        "it asks for ADD, UPDATE or NOOP",
        all(w in context for w in ("ADD", "UPDATE", "NOOP")),
    )
    check("it is PreToolUse context", out.get("hookEventName") == "PreToolUse")
    check("it never decides the write", "permissionDecision" not in out)

    unrelated = memory(
        "zfs-scrub-runs-monthly",
        "The ZFS pool on the NAS scrubs on the first Sunday of each month.",
    )
    quiet = run(store / "zfs-scrub-runs-monthly.md", unrelated)
    check(
        "an unrelated memory prints nothing",
        quiet.stdout == "" and quiet.returncode == 0,
    )

    check(
        "overwriting an existing memory prints nothing",
        run(store / "deploy-renders-from-worktree.md", near).stdout == "",
    )
    check(
        "writing MEMORY.md prints nothing", run(store / "MEMORY.md", near).stdout == ""
    )
    outside = Path(tmp) / "notes" / "memory"
    outside.mkdir(parents=True)
    (outside / "deploy-renders-from-worktree.md").write_text(near)
    check(
        "a memory directory outside the config's projects prints nothing",
        run(outside / "new.md", near).stdout == "",
    )
    check(
        "CLAUDE_MEMORY_NEAREST=0 silences it",
        run(store / "x.md", near, {"CLAUDE_MEMORY_NEAREST": "0"}).stdout == "",
    )

finish()
