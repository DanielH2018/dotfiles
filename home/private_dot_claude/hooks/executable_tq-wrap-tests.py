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

# Anything that makes the command more than one simple command.
SHELL_CHARS = set(";&|<>()`$\n")

# The deployed CLI, since that is what the rewritten command will run. TQ_BIN
# overrides it so a checkout's own tq can be exercised before `chezmoi apply`.
TQ_SOURCE = os.environ.get("TQ_BIN") or os.path.expanduser("~/.local/bin/tq")
TQ_LIB = os.environ.get("TQ_HOME") or os.path.join(
    os.path.dirname(os.path.dirname(TQ_SOURCE)), "share", "tq"
)


def load_detect():
    """tq's own detect(), and the candidate set it is worth asking about.

    From the lib rather than from the CLI. Importing the CLI drags in the XML,
    JSON and subprocess machinery of every adapter for ~74ms, which was tolerable
    while the candidates were test runners and is not now that they include git,
    ls and grep — the programs an agent runs most.
    """
    # This hook stands in front of every Bash call, so whatever is importable here runs
    # on every one of them. TQ_LIB comes from $TQ_HOME when set, which means without a
    # check anything able to set an environment variable chooses the code that gets
    # imported. Require a real directory holding a real module, both owned by this user
    # and not writable by group or others. Raising is the safe outcome: rewrite() is
    # called under a deliberately blind except that leaves the command untouched.
    lib = os.stat(TQ_LIB)
    mod = os.stat(os.path.join(TQ_LIB, "detect.py"))
    if not stat.S_ISDIR(lib.st_mode) or not stat.S_ISREG(mod.st_mode):
        raise ImportError(f"tq lib is not a directory holding a module: {TQ_LIB}")
    me = os.getuid()
    for st in (lib, mod):
        if st.st_uid not in (me, 0) or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ImportError(f"tq lib is not exclusively ours to write: {TQ_LIB}")

    sys.path.insert(0, TQ_LIB)
    try:
        import detect
    finally:
        # Don't leave TQ_LIB on sys.path shadowing every later import in this process.
        with contextlib.suppress(ValueError):
            sys.path.remove(TQ_LIB)

    return detect.detect, detect.CANDIDATES


def rewrite(command):
    """The command to run instead, or None to leave this one alone."""
    if os.environ.get("TQ_OFF") or not os.path.exists(TQ_SOURCE):
        return None
    if not shutil.which("tq"):
        # Resolvable by name or not at all. Prefixing the absolute path would
        # work, but it is what the agent and the user then have to read.
        return None
    if any(char in command for char in SHELL_CHARS):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:  # unbalanced quotes: not ours to interpret
        return None
    if not argv:
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
        updated = rewrite(command)
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
