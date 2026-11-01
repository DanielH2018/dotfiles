"""`runlog` and `redproof` calls judged as the COMMAND each runs.

Both tools (~/.local/bin) run the argv after their `--` and add one bounded side effect of
their own: runlog writes COMMAND's output to a log file it names itself, and redproof runs
COMMAND in a temporary worktree it creates and removes. Two places have to see through them,
or wrapping a command would change how it is judged:

  - judge_segment judges the inner command in full, deny and ask rules and every check
    included (`inner_command`).
  - Claude Code matches permissions.deny and permissions.ask prefixes against the command as
    typed, so `runlog x -- kubectl delete pod` matches neither. The PreToolUse hook re-applies
    claude-guard's deny rules and both settings lists to every inner command (`verdict`).

Each grammar is its tool's own `parse`, and tests/test_wrapped.py runs the real scripts over
the same case tables so the two cannot drift. A wrapper inside a wrapper is refused by both.
"""

import os
import re
import shlex
from collections.abc import Callable, Mapping

from claude_guard.deny import deny
from claude_guard.rules import load_rules
from claude_guard.segment import parse

TOOLS = ("runlog", "redproof")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
USAGE = {
    "runlog": "runlog NAME [--tail N] -- COMMAND…",
    "redproof": "redproof REF PATH… -- COMMAND…",
}


def _runlog_command(rest: list[str]) -> list[str] | None:
    if not rest or not NAME.fullmatch(rest[0]):
        return None
    rest = rest[1:]
    if rest[:1] == ["--tail"]:
        if len(rest) < 2 or not rest[1].isdigit():
            return None
        rest = rest[2:]
    if rest[:1] != ["--"] or len(rest) < 2:
        return None
    return rest[1:]


def _redproof_command(rest: list[str]) -> list[str] | None:
    if "--" not in rest:
        return None
    split = rest.index("--")
    head, command = rest[:split], rest[split + 1 :]
    if len(head) < 2 or not command or any(w.startswith("-") for w in head):
        return None
    return command


def tool_of(words: list[str]) -> str | None:
    """The wrapper `words` invokes, or None."""
    name = os.path.basename(words[0]) if words else ""
    return name if name in TOOLS else None


def inner_argv(words: list[str]) -> list[str] | None:
    """The command a runlog or redproof argv runs, or None when `words` is not a well-formed
    call of either."""
    tool = tool_of(words)
    if tool is None:
        return None
    command = (_runlog_command if tool == "runlog" else _redproof_command)(words[1:])
    if not command or tool_of(command) is not None:
        return None
    return command


def inner_command(text: str) -> str | None:
    """The inner command of a wrapper segment, quoted as one shell word per argument, or None
    when the segment does not parse as one. Quoting each argument keeps a `>` or `|` that the
    wrapper passes literally from reading as a redirect or a pipe."""
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
    """(kind, rule, reason) for the first wrapper segment whose inner command claude-guard's
    deny rules or the settings lists decide, else None. A wrapper segment that does not parse
    is an ask: its command cannot be shown to be anything in particular."""
    parsed = parse(command)
    if not parsed.ok:
        return None
    for seg in parsed.segments:
        text = seg.text.strip()
        tool = tool_of(text.split())
        if tool is None:
            continue
        inner = inner_command(text)
        if inner is None:
            return (
                "ask",
                f"{tool}-unreadable",
                f"claude-guard: this {tool} call does not parse as `{USAGE[tool]}`. "
                "Review the command it runs yourself.",
            )
        found = deny_rules(inner)
        if found is not None:
            return found
        if rules_denies(inner):
            return (
                "deny",
                f"{tool}-settings-deny",
                f"Blocked: {tool} runs `{inner[:120]}`, "
                "which permissions.deny refuses whatever wraps it.",
            )
        if rules_asks(inner):
            return (
                "ask",
                f"{tool}-settings-ask",
                f"claude-guard: {tool} runs `{inner[:120]}`, "
                "which permissions.ask lists. Review it as if it were typed bare.",
            )
    return None


def settings_verdict(command: str, env: Mapping[str, str]) -> tuple[str, str, str] | None:
    """`verdict` against the deployed rules: claude-guard's deny module and the settings lists."""
    if not any(tool in command for tool in TOOLS):
        return None
    rules = load_rules(env=env)

    def deny_rules(inner: str) -> tuple[str, str, str] | None:
        v = deny(inner, "", env)
        return (v.kind, v.rule, v.reason) if v.kind in ("deny", "ask") else None

    return verdict(command, rules.denies, rules.asks, deny_rules)
