#!/usr/bin/env python3
# gen-hooks: register
#   event: PreToolUse
#   matcher: Write
#   timeout: 10
#   order: 70
# The write-time half of memory upkeep. memory-upkeep.py reports drift at session
# start, after a near-duplicate already exists. This hook lists the nearest existing
# memories before a new one lands, and it never blocks the write.
"""PreToolUse hook: before a new memory file is written, list the nearest existing ones.

The memory store grows by addition. The system prompt tells a session to check for an
existing memory before writing a new one, but nothing does that check when the write
happens. Mem0 (https://arxiv.org/abs/2504.19413) makes the comparison mechanical:
before storing a fact it retrieves the most similar memories and has the writer choose
ADD, UPDATE, DELETE or NOOP. This hook is that retrieval step, done with stdlib only.

When it fires. The hook acts on a `Write` whose target is
`<config>/projects/<slug>/memory/<name>.md`. `<config>` is CLAUDE_CONFIG_DIR or
~/.claude. The name must not be MEMORY.md, and the file must not exist yet: overwriting
an existing memory is already an update.

What it scores. The hook compares the `name` and `description` frontmatter of the new
file with the same two fields of every other memory in that directory. The score is the
Jaccard index of their word sets. A word is a lowercase run of letters and digits of
at least three characters that is not a stopword, so a kebab-case name splits into its
parts. The score is deterministic and needs no embeddings.

What it prints. Up to three memories scoring at or above THRESHOLD, each with its name
and description, go out as `additionalContext` on the PreToolUse output. The hook sets
no permission decision, so the write proceeds and a session that already checked loses
only a few lines. Below the threshold it prints nothing.

The threshold. `--calibrate <memory dir>` reports how many existing pairs in a store
cross it. Measured on 2026-10-10, the server repo's store (67 memories with
frontmatter, 2211 pairs) has a median pair score of 0.000, a p99 of 0.067 and one pair
above 0.18: two dated review-state memories at 0.408, which are a real near-duplicate.
The next pair scores 0.179. At 0.25, 1 of 2211 pairs (0.05%) crosses. Every other store
on daniel-box held fewer than two memories. Rerun `--calibrate` when the stores grow,
and move THRESHOLD if ordinary pairs start crossing it.

Opt out with CLAUDE_MEMORY_NEAREST=0. Every failure path is silent: a hook that cannot
read its input has no business adding context to a write.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import sys
from pathlib import Path

THRESHOLD = 0.25
LIMIT = 3

# fmt: off
STOPWORDS = frozenset("""
    the and for are but not you all any can had her was one our out has his how its
    may new now old see two who did get let put say she too use that with have this
    will your from they been more when what which their there them than then into
    only also some such each other would could should does doing done just about over
    after before where while because being were here very like make made must need
""".split())  # noqa: SIM905 - one word list reads better than a 90-item literal
# fmt: on

Memory = tuple[str, str, frozenset[str]]


def frontmatter(text: str) -> tuple[str, str]:
    """Returns the `name` and `description` frontmatter values, or empty strings.

    Reads only top-level keys of the leading `---` block, so a key nested under
    `metadata:` is never taken for one of them. Strips one layer of matching quotes.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return "", ""
    fields = {"name": "", "description": ""}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, value = line.partition(":")
        if sep and key in fields:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            fields[key] = value
    return fields["name"], fields["description"]


def words(name: str, description: str) -> frozenset[str]:
    """Returns the word set the score compares."""
    found = re.findall(r"[a-z0-9]+", f"{name} {description}".lower())
    return frozenset(w for w in found if len(w) >= 3 and w not in STOPWORDS)


def score(a: frozenset[str], b: frozenset[str]) -> float:
    """Returns the Jaccard index of two word sets, or 0.0 when either is empty."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def load_store(memories: Path) -> list[Memory]:
    """Returns (name, description, words) for each memory file in a directory.

    Skips MEMORY.md and any file with neither a name nor a description.
    """
    out = []
    for path in sorted(memories.glob("*.md")):
        if path.name == "MEMORY.md":
            continue
        try:
            name, description = frontmatter(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if name or description:
            out.append((name or path.stem, description, words(name, description)))
    return out


def nearest(new: frozenset[str], store: list[Memory]) -> list[tuple[float, str, str]]:
    """Returns up to LIMIT (score, name, description) scoring THRESHOLD or more."""
    ranked = sorted(
        ((score(new, w), name, desc) for name, desc, w in store),
        key=lambda r: (-r[0], r[1]),
    )
    return [r for r in ranked if r[0] >= THRESHOLD][:LIMIT]


def memory_target(file_path: str, config_dir: Path) -> Path | None:
    """Returns the target path if it is a new file in a project memory store."""
    path = Path(os.path.abspath(Path(file_path).expanduser()))
    if path.suffix != ".md" or path.name == "MEMORY.md" or path.exists():
        return None
    memories = path.parent
    if memories.name != "memory" or not memories.is_dir():
        return None
    try:
        if memories.resolve().parent.parent != (config_dir / "projects").resolve():
            return None
    except OSError:
        return None
    return path


def context(target: Path, hits: list[tuple[float, str, str]]) -> str:
    lines = [
        f"Before writing the new memory {target.name}: these existing memories in "
        "the same store are close to it by name and description.",
        "",
    ]
    lines += [f"- {name} (overlap {value:.2f}): {desc}" for value, name, desc in hits]
    lines += [
        "",
        "Confirm ADD if the new memory states a different fact. Otherwise UPDATE the "
        "existing file instead of creating this one, or write nothing (NOOP) if it "
        "already says this.",
    ]
    return "\n".join(lines)


def calibrate(memories: Path, threshold: float) -> int:
    """Prints the pair-score distribution of a store and how many pairs cross."""
    store = load_store(memories)
    ranked = sorted(
        ((score(a[2], b[2]), a[0], b[0]) for a, b in itertools.combinations(store, 2)),
        reverse=True,
    )
    if not ranked:
        print(f"{memories}: fewer than two memories, nothing to compare")
        return 0
    scores = sorted(r[0] for r in ranked)

    def quantile(q: float) -> float:
        return scores[min(len(scores) - 1, int(q * len(scores)))]

    crossing = sum(1 for s in scores if s >= threshold)
    print(f"{memories}: {len(store)} memories, {len(scores)} pairs")
    print(
        f"pair score  median {quantile(0.5):.3f}  p90 {quantile(0.9):.3f}  "
        f"p99 {quantile(0.99):.3f}  max {scores[-1]:.3f}"
    )
    print(
        f"threshold {threshold:.2f}: {crossing} of {len(scores)} pairs cross it "
        f"({crossing / len(scores):.2%})"
    )
    for value, a, b in ranked[:5]:
        print(f"  {value:.3f}  {a}  ~  {b}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--calibrate",
        type=Path,
        metavar="DIR",
        help="report how many existing memory pairs in DIR cross the threshold",
    )
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    args = parser.parse_args()
    if args.calibrate:
        return calibrate(args.calibrate, args.threshold)

    if os.environ.get("CLAUDE_MEMORY_NEAREST") == "0":
        return 0
    try:
        event = json.load(sys.stdin)
        tool_input = event.get("tool_input") or {}
        file_path = tool_input.get("file_path")
        content = tool_input.get("content")
        if not (isinstance(file_path, str) and isinstance(content, str)):
            return 0
        config_dir = Path(
            os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude"
        )
        target = memory_target(file_path, config_dir)
        if target is None:
            return 0
        new = words(*frontmatter(content))
        if not new:
            return 0
        hits = nearest(new, load_store(target.parent))
    except Exception:  # noqa: BLE001 - a broken hook must not get in a write's way
        return 0
    if hits:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": context(target, hits),
            }
        }
        json.dump(output, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
