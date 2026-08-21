#!/usr/bin/env python3
"""SessionStart hook: report memories that name a repo path which no longer exists.

Memory upkeep is entirely instruction-driven. The system prompt says to update an
existing memory rather than duplicate it, and to delete one that turns out wrong; the
homelab repo's CLAUDE.md adds the corroborate-before-you-promote rule. All of that
governs the moment a memory is written. Nothing fires when a session changes the code a
memory already describes, so drift runs one way: memories are added readily and revised
only when someone happens to notice. Four of this machine's memories name files that
have since been deleted or moved, and each was found by hand.

This is the cheap half of closing that gap, and the half that needs no session context:
a path a memory names either exists or it does not. It reports; it never edits. A memory
can be perfectly correct about a file that was deliberately removed — the point is to
put that in front of a person, not to decide it.

What counts as a path. A backtick-quoted token containing `/` whose FIRST segment is a
directory that exists in the repo root. That second condition is what keeps the report
usable: without it every `refs/heads/x`, `kube-system/foo` and `and/or` reads as a
missing file. The cost is that a memory naming a path in a directory that was itself
deleted goes unreported — a miss, which is the right direction for a hook that only
nudges.

Usage:
    memory-stale-paths.py [--repo DIR]

Opt out with CLAUDE_MEMORY_PATH_CHECK=0.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# Backtick-quoted spans are where this config's memories put paths, and quoting is what
# separates a path from prose that happens to contain a slash.
BACKTICKED = re.compile(r"`([^`\n]+)`")

# A path-ish token: no whitespace, at least one slash, and nothing that makes it a URL,
# a glob, or a shell fragment. Trailing punctuation from the sentence is stripped
# separately.
PATHISH = re.compile(r"^[\w.@+-]+(?:/[\w.@+-]+)+/?$")

# Cap the report. A run that names thirty memories is not a nudge, it is a wall, and the
# session start banner is not the place for it.
MAX_REPORTED = 10


def repo_root(start: Path) -> Path | None:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=start,
        capture_output=True,
        text=True,
        check=False,
    )
    top = result.stdout.strip()
    return Path(top) if result.returncode == 0 and top else None


def memory_dir(config_dir: Path, repo: Path) -> Path | None:
    """Claude Code's per-project memory directory, named after the project path.

    The encoding replaces every separator with a dash, so /home/ubuntu/server becomes
    -home-ubuntu-server. Derived rather than searched: a search would pick up another
    project's memories when two are open at once.
    """
    slug = str(repo).replace("/", "-")
    candidate = config_dir / "projects" / slug / "memory"
    return candidate if candidate.is_dir() else None


def candidate_paths(text: str) -> set[str]:
    found = set()
    for token in BACKTICKED.findall(text):
        token = token.strip().rstrip(".,;:)")
        if PATHISH.match(token):
            found.add(token.rstrip("/"))
    return found


def already_says_it_is_gone(text: str, token: str) -> bool:
    """Does the memory name this path *because* it no longer exists?

    The dominant false positive, and it dominates hard: on the first real run, three of
    the four memories reported were describing an absence rather than asserting a
    presence — "still pointed at `<path>`. That directory has no `files/`", "guarded by
    `<path>`, which no longer exists", "`<path>` … the 11 Error Backup CRs no longer
    exist". Each was correct as written, and re-reporting a memory that already records
    the deletion is how a session-start line teaches its reader to skip it.

    So: look at the prose around the mention for an absence marker. A window rather than
    a sentence, because these files wrap mid-sentence and a line-based read misses the
    half that carries the marker.

    The path is cut out of its own window first, and that is not a detail. A file named
    `remove_stale_backups.py` or `docs/retired-hosts.md` otherwise matches the marker
    list with its own name and suppresses itself forever — the one failure this check
    must not have, since it silences exactly the paths most likely to have been deleted.

    The failure direction is otherwise deliberate. A genuinely stale path in a memory
    that happens to say "removed" nearby goes unreported — a miss, and a miss costs
    nothing here, where a false alarm costs the whole report's credibility.
    """
    markers = (
        "no longer",
        "no such",
        "does not exist",
        "doesn't exist",
        "has no",
        "was deleted",
        "is deleted",
        "was removed",
        "were removed",
        "is gone",
        "are gone",
        "retired",
        "dangling",
        "never existed",
        "never created",
        "declined",
        "not adopted",
        "used to",
        "moved to",
        "replaced by",
        "superseded",
        "which no longer",
    )
    needle = f"`{token}`"
    seen = False
    start = 0
    while True:
        i = text.find(needle, start)
        if i < 0:
            # Every mention carried a marker — or there were none to check, in which
            # case the path got here unquoted and this test has nothing to say about it.
            return seen
        seen = True
        end = i + len(needle)
        # The surrounding prose only. Including the needle lets a path match the marker
        # list with its own filename — see the docstring; that bug silences the very
        # paths most likely to be stale.
        window = (text[max(0, i - 200) : i] + " " + text[end : end + 200]).lower()
        if not any(m in window for m in markers):
            # One mention that reads as a live claim is enough to report the path.
            return False
        start = i + len(needle)


def stale_paths(text: str, repo: Path) -> list[str]:
    """Paths this memory names that are gone, given their top directory still exists."""
    gone = []
    for token in candidate_paths(text):
        head = token.split("/", 1)[0]
        if head in (".", ".."):
            # `./repos` is written relative to somewhere the memory names in prose, not
            # to the repo root, so resolving it here answers a question nobody asked.
            continue
        if not (repo / head).is_dir():
            continue  # not a path into this repo, or its whole directory is gone
        if (repo / token).exists():
            continue
        if already_says_it_is_gone(text, token):
            continue
        gone.append(token)
    return sorted(gone)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Report memories naming repo paths that no longer exist."
    )
    parser.add_argument("--repo", default=None, help="repository to check against")
    args = parser.parse_args()

    if os.environ.get("CLAUDE_MEMORY_PATH_CHECK") == "0":
        return 0

    repo = Path(args.repo) if args.repo else repo_root(Path.cwd())
    if repo is None or not repo.is_dir():
        return 0

    config_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    memories = memory_dir(config_dir, repo)
    if memories is None:
        return 0

    findings = []
    for path in sorted(memories.glob("*.md")):
        if path.name == "MEMORY.md":
            continue  # the index: it links memories, it does not describe code
        try:
            text = path.read_text()
        except OSError:
            continue
        gone = stale_paths(text, repo)
        if gone:
            findings.append((path.name, gone))

    # Silent when there is nothing to say. This runs at every session start, where an
    # all-clear line every time is the fastest way to train someone to stop reading.
    if not findings:
        return 0

    print(
        f"{len(findings)} memor{'y' if len(findings) == 1 else 'ies'} name a path that "
        "no longer exists — check whether the memory is stale or the file simply moved:"
    )
    for name, gone in findings[:MAX_REPORTED]:
        print(f"  {name}: {', '.join(gone)}")
    if len(findings) > MAX_REPORTED:
        print(f"  ... and {len(findings) - MAX_REPORTED} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
