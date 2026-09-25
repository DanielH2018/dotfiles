#!/usr/bin/env python3
# gen-hooks: library
#   reason: authority behind tq-wrap-tests.sh, which holds the PreToolUse registration
"""PreToolUse hook: route an agent's test and lint commands through tq.

A `node --test` run over this repo prints ~65KB that nobody reads when nothing
is wrong. In a git hook that is noise; in an agent's Bash call it is context,
spent at the same rate whether or not anything failed, and spent again by every
parallel agent running the same suite. tq collapses it to a verdict plus a
`json:` path, so the detail stays one Read away when a failure needs it.

The rewrite is deliberately timid, because this sits in front of every Bash call
the agent makes:

  * only a single simple command is ever touched — no pipeline, chain,
    redirect or substitution, where a `tq` prefix would wrap the first stage
    and silently change what the shell does with the rest;
  * only commands tq itself claims, asked of tq's own detect() rather than a
    copy of its rules, so the two cannot drift apart;
  * every unexpected condition returns without output, which means no change.
    A hook that cannot understand its input must not rewrite the command.

Escape hatches: `TQ_OFF=1 node --test ...` is left alone (an assignment is not
a program name, so the rewrite never fires), and TQ_OFF in the hook's own
environment disables it wholesale.
"""

from __future__ import annotations

import contextlib
import json
import os
import shlex
import shutil
import stat
import sys

# Shell syntax that can sit inside one simple command. A redirect, an expansion or
# a subshell is not an argv tq can wrap, so any of these leaves the command alone.
# Whether the command IS one simple command is claude_guard.segment's call, not a
# character's: a `;` inside quotes is an argument, not a separator (#580).
SHELL_SYNTAX = set("<>()`$")

# The deployed CLI, since that is what the rewritten command will run. TQ_BIN
# overrides it so a checkout's own tq can be exercised before `chezmoi apply`.
TQ_SOURCE = os.environ.get("TQ_BIN") or os.path.expanduser("~/.local/bin/tq")
TQ_LIB = os.environ.get("TQ_HOME") or os.path.join(
    os.path.dirname(os.path.dirname(TQ_SOURCE)), "share", "tq"
)
# The command parser the deny hook runs, so both read a command's structure alike.
GUARD_SHARE = os.environ.get("CLAUDE_GUARD_HOME") or os.path.expanduser(
    "~/.local/share/claude-guard"
)


def import_private(root, package_path, name):
    """Import `name` from `root`, only if every path on the way is exclusively ours.

    This hook stands in front of every Bash call, so whatever is importable here
    runs on every one of them. Both roots come from an environment variable when
    set, which means without a check anything able to set one chooses the code that
    gets imported. Require real directories holding a real module, all owned by this
    user (or root) and not writable by group or others. Raising is the safe outcome:
    rewrite() is called under a deliberately blind except that leaves the command
    untouched.
    """
    parts = package_path.split("/")
    dirs = [os.path.join(root, *parts[:i]) for i in range(len(parts))]
    module = os.path.join(root, *parts)
    stats = [os.stat(d) for d in dirs] + [os.stat(module)]
    if not all(stat.S_ISDIR(st.st_mode) for st in stats[:-1]) or not stat.S_ISREG(
        stats[-1].st_mode
    ):
        raise ImportError(f"not a directory holding a module: {module}")
    me = os.getuid()
    for st in stats:
        if st.st_uid not in (me, 0) or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ImportError(f"not exclusively ours to write: {module}")

    sys.path.insert(0, root)
    try:
        return __import__(name, fromlist=["_"])
    finally:
        # Don't leave the root on sys.path shadowing every later import here.
        with contextlib.suppress(ValueError):
            sys.path.remove(root)


def load_detect():
    """tq's own detect(), and the candidate set it is worth asking about.

    From the lib rather than from the CLI. Importing the CLI drags in the XML,
    JSON and subprocess machinery of every adapter for ~74ms, which was tolerable
    while the candidates were test runners and is not now that they include git,
    ls and grep — the programs an agent runs most.
    """
    detect = import_private(TQ_LIB, "detect.py", "detect")
    return detect.detect, detect.CANDIDATES


def one_simple_command(command):
    """Whether claude_guard.segment reads `command` as exactly one simple command."""
    parse = import_private(
        GUARD_SHARE, "claude_guard/segment.py", "claude_guard.segment"
    ).parse
    p = parse(command)
    return (
        p.ok
        and len(p.segments) == 1
        and not p.substitutions
        and not p.segments[0].heredocs
    )


def in_isolated_worktree(cwd):
    """Whether `cwd` is inside a Claude Code worktree under `.claude/worktrees/`.

    Claude Code refuses a worktree-isolated session's git command when a launcher
    stands in front of it, because it cannot prove where the git call runs. A
    `tq git log` is exactly that shape, so there the rewrite would turn a working
    read into a refused one (DanielH2018/server#2454). EnterWorktree and
    `isolation: "worktree"` agents both place their checkout under this path.
    """
    return f"{os.sep}.claude{os.sep}worktrees{os.sep}" in os.path.join(cwd, "")


def rewrite(command, cwd=""):
    """The command to run instead, or None to leave this one alone."""
    if os.environ.get("TQ_OFF") or not os.path.exists(TQ_SOURCE):
        return None
    if not shutil.which("tq"):
        # Resolvable by name or not at all. Prefixing the absolute path would
        # work, but it is what the agent and the user then have to read.
        return None
    if any(char in command for char in SHELL_SYNTAX):
        return None
    if not one_simple_command(command):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:  # unbalanced quotes: not ours to interpret
        return None
    if not argv:
        return None
    if os.path.basename(argv[0]) == "git" and in_isolated_worktree(cwd):
        return None
    detect, candidates = load_detect()
    # Both the shortlist and the decision come from tq's own module. Keeping a
    # copy of the shortlist here would save the import on most calls and is what
    # this used to do, but the two would then drift, and the failure that causes
    # is a command tq claims that the hook never offers it.
    if os.path.basename(argv[0]) not in candidates:
        return None
    if detect(argv) is None:
        return None
    return f"tq {command}"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:  # noqa: BLE001 — fail open; see below
        return
    if payload.get("tool_name") != "Bash":
        return
    command = (payload.get("tool_input") or {}).get("command") or ""
    try:
        updated = rewrite(command, payload.get("cwd") or "")
    except Exception:  # noqa: BLE001
        # Both catches are deliberately blind, and that is the whole design:
        # this hook stands in front of every Bash call the agent makes, so any
        # failure in it must leave the command untouched rather than propagate.
        # Narrowing these would let an unanticipated error escape and take a
        # working command down with it.
        return
    if not updated:
        return
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {"command": updated},
            }
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
