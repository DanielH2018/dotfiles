"""What a hooks-block command runs, and the description its hook file declares.

A registration's command names either the hook itself (`~/.claude/hooks/foo.sh start`) or
a launcher under `hooks/lib/` that takes the hook as its first argument
(`bash ~/.claude/hooks/lib/run-python.sh stop-checks.py`). The map lists the hook, never
the launcher.

The description is the `#   description:` line of the hook's `# gen-hooks: register`
block. bin/gen-hooks requires one on every registration, so this reads a declared value
rather than guessing a purpose from the prose around it.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from pathlib import Path

HOOKS_PREFIX = "~/.claude/hooks/"
OPENER_RE = re.compile(r"^# gen-hooks: register\s*$")
FIELD_RE = re.compile(r"^#   ([a-zA-Z]+): (.*)$")


@dataclass(frozen=True)
class HookCommand:
    label: str  # the hook's path relative to hooks/, e.g. "stop-checks.py"
    args: str  # the arguments after the hook, space-joined


def parse_command(command: str) -> HookCommand | None:
    """The hook a command runs, or None for an inline command naming no hook file."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    for i, token in enumerate(tokens):
        if not token.startswith(HOOKS_PREFIX):
            continue
        rel = token[len(HOOKS_PREFIX) :]
        rest = tokens[i + 1 :]
        # run-python.sh's rule: an argument with no `/` names a file in hooks/.
        if rel.startswith("lib/") and rest and "/" not in rest[0]:
            rel, rest = rest[0], rest[1:]
        return HookCommand(label=rel, args=" ".join(rest))
    return None


def _register_blocks(text: str) -> list[dict[str, str]]:
    blocks = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not OPENER_RE.match(line):
            continue
        fields = {}
        for cont in lines[i + 1 :]:
            match = FIELD_RE.match(cont)
            if not match:
                break
            fields[match.group(1)] = match.group(2).strip()
        blocks.append(fields)
    return blocks


def declared_description(
    path: Path, event: str, matcher: str | None, args: str
) -> str | None:
    """The description of the register block in `path` that this registration came from.

    A file may register several times (chezmoi-guard.sh: one block per event), so the
    block is picked by event and matcher, then by args when those still tie.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    blocks = [
        b
        for b in _register_blocks(text)
        if b.get("event") == event and b.get("matcher") == matcher
    ]
    if len(blocks) > 1:
        blocks = [b for b in blocks if b.get("args", "") == args] or blocks
    for block in blocks:
        if block.get("description"):
            return block["description"]
    return None
