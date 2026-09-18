#!/usr/bin/env python3
# gen-hooks: register
#   event: SessionStart
#   matcher: startup
#   timeout: 10
#   order: 40
# The startup slot memory-stale-paths.py runs in, the other half of memory upkeep:
# MEMORY.md is injected
# verbatim into every session and grows by appending, so this warns once
# the index passes 50 pointer lines. Silent under the cap, and it reports
# rather than edits — which entry to promote into a rule and which to
# archive is a judgment call with session context behind it.
"""SessionStart hook: warn when the project's MEMORY.md index has outgrown its cap.

MEMORY.md is injected verbatim at every session start, and nothing bounds it. It grows
by roughly six pointer lines a day because appending is the cheap move: a new memory
gets a new line, and consolidating two overlapping entries into one costs thought. The
result is an index that charges every session for entries nobody has reread in weeks.

This is the nudge that puts the number in front of a person. It counts pointer lines —
lines starting with `- [`, the one shape every entry in this index uses — and prints
when the count is over the cap. It never edits the index: which entries are worth
promoting into a CLAUDE.md rule, which belong in an archive pointer, and which are
simply still live is a judgment call with session context behind it, and a hook has
none of that.

Silent under the cap, because a line that prints at every session start whatever the
state is a line that trains its reader to skip it — the same reasoning as
memory-stale-paths.py, whose path-derivation this borrows.

Fails closed to silence. Every path returns 0, including the error paths: a broken
session-start hook is worse than a missing nudge.

Usage:
    memory-index-size.py [--repo DIR] [--max N]

Opt out with CLAUDE_MEMORY_INDEX_CHECK=0.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

# The cap. Not a hard limit on anything — a point at which appending another line
# should stop being automatic.
#
# A ratchet, set just above the current count rather than at some ideal size. The index
# was cut from 92 entries to 80 in the same pass that added this hook, so a cap of 50
# would have fired at every session start with no reachable target — and a warning
# nobody can satisfy is a warning everybody learns to skip. 85 stays silent after that
# cleanup and speaks again once a few more entries accumulate. Lower it when the index
# is genuinely smaller, not before.
DEFAULT_MAX_ENTRIES = 85

# Every entry in this index is a markdown link bullet. Prose lines, headings and blank
# lines are not entries and must not be counted.
POINTER_PREFIX = "- ["


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


def main_checkout(repo: Path) -> Path:
    """The main checkout behind `repo`, which may be a linked worktree.

    Memory is keyed to the main checkout's path, so a session running in
    .claude/worktrees/<name> derives a slug no memory directory answers to and the hook
    goes silent. This repo runs several parallel worktree sessions at once, so matching
    memory-stale-paths.py's plain repo-root derivation would leave the gate firing
    almost nowhere.

    `git rev-parse --git-common-dir` names the shared .git that every worktree of a repo
    points at; its parent is the main checkout. In the main checkout itself the answer
    is already that repo, so this costs one git call and changes nothing.

    Falls back to `repo` whenever the answer is unusable — git failing, an empty answer,
    a bare repo whose .git parent is not a checkout. A wrong slug is silence, which is
    the same failure as not looking at all, and never an error at session start.
    """
    result = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    common = result.stdout.strip()
    if result.returncode != 0 or not common:
        return repo
    git_dir = Path(common)
    if not git_dir.is_absolute():
        # Git answers ".git" in the main checkout and may answer relatively elsewhere;
        # both are relative to the directory the command ran in.
        git_dir = repo / git_dir
    try:
        parent = git_dir.resolve().parent
    except OSError:
        return repo
    return parent if parent.is_dir() else repo


def memory_index(config_dir: Path, repo: Path) -> Path | None:
    """Claude Code's per-project MEMORY.md, named after the project path.

    Derived rather than searched or hardcoded — the same encoding
    memory-stale-paths.py uses, which replaces every separator with a dash, so
    /home/ubuntu/server becomes -home-ubuntu-server. Deriving is what keeps this hook
    silent in every project that has no memory index of its own.
    """
    slug = str(main_checkout(repo)).replace("/", "-")
    candidate = config_dir / "projects" / slug / "memory" / "MEMORY.md"
    return candidate if candidate.is_file() else None


def count_pointers(text: str) -> int:
    return sum(1 for line in text.splitlines() if line.startswith(POINTER_PREFIX))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Warn when the project memory index exceeds its pointer-line cap."
    )
    parser.add_argument("--repo", default=None, help="repository to check against")
    parser.add_argument(
        "--max", type=int, default=DEFAULT_MAX_ENTRIES, help="pointer-line cap"
    )
    args = parser.parse_args()

    if os.environ.get("CLAUDE_MEMORY_INDEX_CHECK") == "0":
        return 0

    repo = Path(args.repo) if args.repo else repo_root(Path.cwd())
    if repo is None or not repo.is_dir():
        return 0

    config_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    index = memory_index(config_dir, repo)
    if index is None:
        return 0

    try:
        text = index.read_text()
    except OSError:
        # Fail closed to silence: an unreadable index is not something a session-start
        # banner can act on, and an error here would break the session start itself.
        return 0

    count = count_pointers(text)
    if count <= args.max:
        return 0

    print(
        f"MEMORY.md holds {count} pointer lines, over the {args.max} cap — it is "
        "injected verbatim into every session, so each line is charged every time. "
        "Promote or archive entries rather than appending another: fold a finding "
        "into a CLAUDE.md rule or an executable check when it has a durable owner, "
        "merge overlapping entries, and move settled history behind one archive "
        "pointer."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
