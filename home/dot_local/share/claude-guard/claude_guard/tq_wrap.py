"""Route an agent's test and lint commands through tq: the hooks/tq-wrap-tests.py port.

A `node --test` run over the dotfiles repo prints ~65KB that nobody reads when nothing is
wrong. In an agent's Bash call that is context, spent at the same rate whether or not
anything failed. tq collapses it to a verdict plus a `json:` path, so the detail stays one
Read away when a failure needs it. This rides on the PreToolUse process claude_guard already
runs for every Bash call, which was a second interpreter start of its own before.

The rewrite is deliberately timid, because it sits in front of every Bash call:

  * only a single simple command is ever touched -- no pipeline, chain, redirect or
    substitution, where a `tq` prefix would wrap the first stage and silently change what
    the shell does with the rest;
  * only commands tq itself claims, asked of tq's own detect() rather than a copy of its
    rules, so the two cannot drift apart;
  * every unexpected condition is no rewrite. A rewrite that cannot understand its input
    must not change the command (claude_guard.hook calls this under a blind except).

Escape hatches: `TQ_OFF=1 node --test ...` is left alone (an assignment is not a program
name, so the rewrite never fires), and TQ_OFF in the hook's own environment disables it.
"""

import contextlib
import os
import shlex
import stat
import sys
from collections.abc import Mapping
from shutil import which
from types import ModuleType

from claude_guard.segment import parse

# Shell syntax that can sit inside one simple command. A redirect, an expansion or a
# subshell is not an argv tq can wrap. Whether the command IS one simple command is the
# parser's call, not a character's: a `;` inside quotes is an argument (#580).
SHELL_SYNTAX = set("<>()`$")


def import_private(root: str, package_path: str, name: str) -> ModuleType:
    """Imports `name` from `root`, only if every path on the way is exclusively ours.

    This runs in the process that decides denies, so whatever is importable here runs on
    every Bash call, and the root comes from an environment variable when set. Require real
    directories holding a real module, all owned by this user (or root) and not writable by
    group or others.

    Raises:
        ImportError: a path on the way fails those checks.
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


def one_simple_command(command: str) -> bool:
    p = parse(command)
    return p.ok and len(p.segments) == 1 and not p.substitutions and not p.segments[0].heredocs


def in_isolated_worktree(cwd: str) -> bool:
    """Whether `cwd` is inside a Claude Code worktree under `.claude/worktrees/`.

    Claude Code refuses a worktree-isolated session's git command when a launcher stands in
    front of it, because it cannot prove where the git call runs. A `tq git log` is exactly
    that shape, so there the rewrite would turn a working read into a refused one
    (DanielH2018/server#2454).
    """
    return f"{os.sep}.claude{os.sep}worktrees{os.sep}" in os.path.join(cwd, "")


def rewrite(command: str, cwd: str, env: Mapping[str, str]) -> str | None:
    """The command to run instead, or None to leave this one alone.

    TQ_BIN names the tq CLI the rewritten command will run (default ~/.local/bin/tq) and
    TQ_HOME its library, so a checkout's own tq can be exercised before `chezmoi apply`.

    Raises:
        Exception: anything; the caller treats it as no rewrite.
    """
    home = env.get("HOME", "")
    tq_source = env.get("TQ_BIN") or os.path.join(home, ".local", "bin", "tq")
    tq_lib = env.get("TQ_HOME") or os.path.join(
        os.path.dirname(os.path.dirname(tq_source)), "share", "tq"
    )
    if env.get("TQ_OFF") or not home or not os.path.exists(tq_source):
        return None
    # Resolvable by name or not at all: an absolute path is what the agent and the user
    # would then have to read.
    if not which("tq", path=env.get("PATH", "")):
        return None
    if any(char in command for char in SHELL_SYNTAX) or not one_simple_command(command):
        return None
    try:
        argv = shlex.split(command)
    except ValueError:  # unbalanced quotes: not ours to interpret
        return None
    if not argv:
        return None
    if os.path.basename(argv[0]) == "git" and in_isolated_worktree(cwd):
        return None
    # From tq's lib rather than its CLI: importing the CLI drags in every adapter for ~74ms.
    detect = import_private(tq_lib, "detect.py", "detect")
    if os.path.basename(argv[0]) not in detect.CANDIDATES or detect.detect(argv) is None:
        return None
    return f"tq {command}"
