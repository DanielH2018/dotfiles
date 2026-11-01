"""`runlog NAME [--tail N] -- COMMAND…` judged as the COMMAND it runs.

runlog (~/.local/bin/runlog) runs its argv after `--` with the output captured to a log file
it names itself, so the only thing a runlog call does beyond COMMAND is write that one file.
Two places have to see through it, or wrapping a command would change how it is judged:

  - judge_segment judges the inner command in full, deny and ask rules and every check
    included (`inner_command`).
  - Claude Code matches permissions.deny and permissions.ask prefixes against the command as
    typed, so `runlog x -- kubectl delete pod` matches neither. The PreToolUse hook re-applies
    claude-guard's deny rules and both settings lists to every inner command (`verdict`).

The grammar is runlog's own `parse`, and tests/test_runlog.py runs the real script over the
same case table so the two cannot drift. A nested runlog is refused by both.
"""

import os
import re
import shlex
from collections.abc import Callable, Mapping

from claude_guard.deny import deny
from claude_guard.rules import load_rules
from claude_guard.segment import parse

NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")


def inner_argv(words: list[str]) -> list[str] | None:
    """The command a runlog argv runs, or None when `words` is not a well-formed runlog call."""
    if not words or os.path.basename(words[0]) != "runlog":
        return None
    rest = words[1:]
    if not rest or not NAME.fullmatch(rest[0]):
        return None
    rest = rest[1:]
    if rest[:1] == ["--tail"]:
        if len(rest) < 2 or not rest[1].isdigit():
            return None
        rest = rest[2:]
    if rest[:1] != ["--"] or len(rest) < 2:
        return None
    command = rest[1:]
    if os.path.basename(command[0]) == "runlog":
        return None
    return command


def is_runlog(text: str) -> bool:
    words = text.split()
    return bool(words) and os.path.basename(words[0]) == "runlog"


def inner_command(text: str) -> str | None:
    """The inner command of a runlog segment, quoted as one shell word per argument, or None
    when the segment does not parse as one. Quoting each argument keeps a `>` or `|` that
    runlog passes literally from reading as a redirect or a pipe."""
    try:
        argv = inner_argv(shlex.split(text))
    except ValueError:
        return None
    return shlex.join(argv) if argv else None


def verdict(
    command: str,
    rules_denies: Callable[[str], bool],
    rules_asks: Callable[[str], bool],
    deny_rules: Callable[[str], tuple[str, str, str] | None],
) -> tuple[str, str, str] | None:
    """(kind, rule, reason) for the first runlog segment whose inner command claude-guard's deny
    rules or the settings lists decide, else None. A runlog segment that does not parse is an
    ask: its command cannot be shown to be anything in particular."""
    parsed = parse(command)
    if not parsed.ok:
        return None
    for seg in parsed.segments:
        text = seg.text.strip()
        if not is_runlog(text):
            continue
        inner = inner_command(text)
        if inner is None:
            return (
                "ask",
                "runlog-unreadable",
                "claude-guard: this runlog call does not parse as "
                "`runlog NAME [--tail N] -- COMMAND…`. Review the command it runs yourself.",
            )
        found = deny_rules(inner)
        if found is not None:
            return found
        if rules_denies(inner):
            return (
                "deny",
                "runlog-settings-deny",
                f"Blocked: runlog runs `{inner[:120]}`, "
                "which permissions.deny refuses whatever wraps it.",
            )
        if rules_asks(inner):
            return (
                "ask",
                "runlog-settings-ask",
                f"claude-guard: runlog runs `{inner[:120]}`, "
                "which permissions.ask lists. Review it as if it were typed bare.",
            )
    return None


def settings_verdict(command: str, env: Mapping[str, str]) -> tuple[str, str, str] | None:
    """`verdict` against the deployed rules: claude-guard's deny module and the settings lists."""
    if "runlog" not in command:
        return None
    rules = load_rules(env=env)

    def deny_rules(inner: str) -> tuple[str, str, str] | None:
        v = deny(inner, "", env)
        return (v.kind, v.rule, v.reason) if v.kind in ("deny", "ask") else None

    return verdict(command, rules.denies, rules.asks, deny_rules)
