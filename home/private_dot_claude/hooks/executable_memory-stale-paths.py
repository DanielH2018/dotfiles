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

The second half reads the index. An entry MEMORY.md marks `[ENFORCED]` or `(SCOPED)` is
a memory promoted to a test or a hook and kept as a pointer; the pointer outlives the
check when the test is renamed or the hook retired, and nothing else re-reads it. For
each marked entry the check its memory names — a file, a pytest node id, a `symbol` in
a `file` — is resolved against the repo, and a missing one is reported. A pointer-only
entry (ENFORCED, not SCOPED) with a missing check is reported as retirable; a SCOPED one
keeps a body describing what the check does not cover, so it gets the stale-reference
warning only. It reports; it never edits, and it never expires an entry on its own.

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

# End of a sentence: terminal punctuation followed by a space or newline, or a blank
# line. A bare newline is NOT one — these files wrap mid-sentence. An em-dash aside is
# not one either, so a marker inside the same sentence's aside still counts.
SENTENCE_BREAK = re.compile(r"[.!?][ \n]|\n[ \t]*\n")

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


def main_checkout(repo: Path) -> Path:
    """The main checkout behind `repo`, which may be a linked worktree.

    Memory is keyed to the main checkout's path, so a session running in
    .claude/worktrees/<name> derives a slug no memory directory answers to and this hook
    goes silent — in exactly the parallel worktree sessions where most work happens.

    `git rev-parse --git-common-dir` names the shared .git that every worktree of a repo
    points at; its parent is the main checkout. In the main checkout itself the answer
    is already that repo, so this costs one git call and changes nothing.

    Use it for the memory slug ONLY. Path existence must stay against the caller's own
    worktree: a file added on a branch does not exist in the main checkout, and checking
    there would report a live path as stale.

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
    for span in BACKTICKED.findall(text):
        # A span is either a bare path or a command line that names one. Splitting on
        # whitespace covers both: a bare path is a single word and survives unchanged.
        # Without the split, the most common way a memory names a script — inside the
        # command that runs it — was invisible, because the span holds spaces and
        # PATHISH rejects it whole. `uv run python scripts/prune_worktrees.py --prune`
        # was the live example, and that script had moved to scripts/dev/.
        for token in span.split():
            token = token.strip().rstrip(".,;:)")
            if PATHISH.match(token):
                found.add(token.rstrip("/"))
    return found


def sentence_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    """Offsets of the sentence containing text[start:end].

    Scopes the absence-marker search below. A +/-200 character window was the first
    shape and it read across sentence boundaries in both directions, which cost recall
    where it hurts most: `worktree-remove-refuses-while-locked.md` says "a lock whose
    process is gone is ignored" one sentence before it names a path that really had
    moved, and `is gone` inside that window suppressed the report. Measured 2026-08-29,
    the hook reported three memories and every one was a deliberate mention, while the
    two genuinely stale paths on this machine were both suppressed this way.

    Sentence rather than line, because these files wrap mid-sentence — a line-based read
    misses the half carrying the marker, which is the failure the window was chosen to
    avoid in the first place.
    """
    left = 0
    for match in SENTENCE_BREAK.finditer(text, 0, start):
        left = match.end()
    match = SENTENCE_BREAK.search(text, end)
    return left, match.start() if match else len(text)


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
    # The bare token, not a backtick-wrapped one. Since candidate_paths started reading
    # inside command spans, a path can be mentioned without backticks of its own, and a
    # backtick-wrapped needle finds no occurrence at all — which reads as "no mention
    # carried a marker" and reports every such path unsuppressably.
    needle = token
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
        left, right = sentence_bounds(text, i, end)
        window = (text[left:i] + " " + text[end:right]).lower()
        if not any(m in window for m in markers):
            # One mention that reads as a live claim is enough to report the path.
            return False
        start = i + len(needle)


def stale_paths(text: str, repo: Path, also: Path | None = None) -> list[str]:
    """Paths this memory names that are gone, given their top directory still exists.

    `also` is the main checkout when `repo` is a linked worktree. A path present in
    EITHER counts as present. Existence is checked against `repo` first because that is
    the tree the session is working in, but an untracked path — a gitignored directory,
    a scratch file — exists only in the checkout it was created in and never in a
    worktree, so checking the worktree alone reported it as deleted. Measured on
    2026-08-29: two of the three memories the hook flagged named `docs/superpowers/`,
    which is gitignored, present in the main checkout, absent from every worktree.

    The cost is a miss in one direction: a branch that DELETES a tracked file still
    finds it in the main checkout and stays quiet. That is the failure direction this
    hook already takes everywhere else — a miss costs nothing, a false alarm costs the
    report's credibility.
    """
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
        if also is not None and (also / token).exists():
            continue
        if already_says_it_is_gone(text, token):
            continue
        gone.append(token)
    return sorted(gone)


# ── the enforced-entry half ──────────────────────────────────────────────────────────
#
# An index entry marked [ENFORCED] or (SCOPED) is prose that was promoted to a test or a
# hook and kept as a pointer. The pointer outlives the check: nothing re-reads it when
# the test is renamed or the hook retired, and a pointer to nothing is the worst memory
# in the index — it tells the reader a hazard is handled when it is not.
#
# Two states, and the policy between them comes from the index's own definition. A FULL
# entry (marked ENFORCED, not SCOPED) is a pointer-only stub: once its check is gone it
# has nothing left to say and is reported as retirable. A SCOPED entry keeps a body
# describing what the check does NOT cover, so its stale check is reported as a stale
# reference and never as a retire suggestion.

# A markdown link to a memory file: `[label](file.md)`. The label may hold one level of
# brackets — "[A task tagged [config, deploy] is skipped …](…)" is a live entry, and a
# label pattern that stops at the first `]` never sees its marker.
INDEX_LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])+\]\(([^)\s]+\.md)\)")

# The markers, as the index writes them: `[ENFORCED]`, `[ENFORCED, SCOPED]`, `(SCOPED)`.
# Read as independent substrings of the bracket or paren text, since the combined form
# is real.
INDEX_MARKER = re.compile(r"\[(ENFORCED[^\]]*)\]|\((SCOPED)\)")

# A pytest node id: a path, then one or more `::name` segments. PATHISH rejects the
# `::`, which is why node ids were invisible to the path scan. A parametrize suffix
# (`test_x[param]`) is dropped from the last segment.
NODE_ID = re.compile(r"^([\w.@+/-]+)((?:::[\w]+)+)(?:\[[^\]]*\])?$")

# A bare `::name`, relative to the last file the same sentence named — the index writes
# "paired in `a/test_b.py::test_c` (with `::test_d`)".
BARE_NODE = re.compile(r"^((?:::[\w]+)+)(?:\[[^\]]*\])?$")

# "`symbol` in `path/to/file.py`": a function or constant a memory names as the check,
# with the file it lives in. A definition is `def name`, `class name` or `name =`.
SYMBOL_IN_FILE = re.compile(r"`(\w+)` in `([\w.@+/-]+)`")

# The sentences that name a check. The markers are written as words in the body too —
# "ENFORCED by `…`", "SCOPED: the check covers `…`", "enforceable: yes — `…`" — and
# every check reference the corpus carries sits in one of those sentences.
CHECK_SENTENCE = re.compile(r"\benforc\w*|\bscoped\b", re.IGNORECASE)


def index_entries(index_text: str) -> list[tuple[str, bool]]:
    """(memory file name, scoped) for every index entry carrying a marker.

    Markers bind to the nearest PRECEDING link, not to the line: a bullet carries
    several links with a marker after each, and a line-level read either downgrades
    the first to the second's marker or hands an unmarked third one it never had.
    """
    entries = []
    for line in index_text.splitlines():
        links = list(INDEX_LINK.finditer(line))
        for i, link in enumerate(links):
            tail_end = links[i + 1].start() if i + 1 < len(links) else len(line)
            tail = line[link.end() : tail_end]
            enforced = scoped = False
            for m in INDEX_MARKER.finditer(tail):
                text = (m.group(1) or m.group(2)).upper()
                enforced |= "ENFORCED" in text
                scoped |= "SCOPED" in text
            if enforced or scoped:
                entries.append((link.group(1), scoped))
    return entries


def named_checks(text: str) -> list[tuple[str, str | None]]:
    """(file, symbol-or-None) per check the memory's ENFORCED/SCOPED sentences name.

    A file alone is a hook, a script or a test module; a symbol is a pytest test name
    or a function the memory says implements the check. Order follows the text, which
    is what lets a bare `::name` resolve against the file named just before it.
    """
    checks: list[tuple[str, str | None]] = []
    seen: set[tuple[str, str | None]] = set()
    sentences_read: set[tuple[int, int]] = set()

    def add(file: str, symbol: str | None) -> None:
        key = (file.rstrip("/"), symbol)
        if key not in seen:
            seen.add(key)
            checks.append(key)

    for m in CHECK_SENTENCE.finditer(text):
        left, right = sentence_bounds(text, m.start(), m.end())
        if (left, right) in sentences_read:
            continue  # "ENFORCED … SCOPED" in one sentence: read it once
        sentences_read.add((left, right))
        sentence = text[left:right]
        last_file: str | None = None
        holders: set[str] = set()
        for sym, file in SYMBOL_IN_FILE.findall(sentence):
            add(file, sym)
            holders.add(file.rstrip("/"))
        for span in BACKTICKED.findall(sentence):
            for token in span.split():
                token = token.strip().rstrip(".,;:)")
                node = NODE_ID.match(token)
                if node:
                    file = node.group(1)
                    for name in node.group(2).split("::")[1:]:
                        add(file, name)
                    last_file = file
                    continue
                bare = BARE_NODE.match(token)
                if bare and last_file:
                    for name in bare.group(1).split("::")[1:]:
                        add(last_file, name)
                    continue
                if PATHISH.match(token) and "." in token.rsplit("/", 1)[-1]:
                    # File-like only: a directory named in passing is not the check.
                    # A file already carrying a symbol is checked through it.
                    if token.rstrip("/") not in holders:
                        add(token, None)
                    last_file = token.rstrip("/")
    return checks


def find_file(rel: str, repo: Path, also: Path | None) -> Path | None:
    """The check's file, in the session's worktree first and the main checkout second —
    the same pair `stale_paths` uses, for the same reason."""
    for base in (repo, also):
        if base is not None and (base / rel).is_file():
            return base / rel
    return None


def defines(path: Path, symbol: str) -> bool:
    try:
        text = path.read_text()
    except OSError:
        return False
    name = re.escape(symbol)
    pattern = rf"^\s*(?:async\s+def|def|class)\s+{name}\b|^\s*{name}\s*="
    return re.search(pattern, text, re.MULTILINE) is not None


def stale_checks(
    text: str, repo: Path, also: Path | None = None
) -> tuple[list[str], list[str]]:
    """(missing, resolved) check references for one marked memory.

    A reference is missing when its file is absent from both trees, or when the file
    exists and does not define the named symbol. No absence-marker suppression here,
    deliberately: a memory whose body says its check "no longer" exists is exactly the
    entry to report, where for a plain path the same words are a reason to stay quiet.
    """
    missing, resolved = [], []
    for file, symbol in named_checks(text):
        head = file.split("/", 1)[0]
        if head in (".", "..") or not (repo / head).is_dir():
            # The path scan's rule, for the same reason: a memory writes
            # `pre_tasks/load_secrets.yml` relative to a directory it names in prose,
            # and reporting it as a missing check would be a false alarm.
            continue
        label = f"{file}::{symbol}" if symbol else file
        found = find_file(file, repo, also)
        if found is None or (symbol and not defines(found, symbol)):
            missing.append(label)
        else:
            resolved.append(label)
    return missing, resolved


def enforced_findings(
    memories: Path, repo: Path, also: Path | None
) -> list[tuple[str, bool, list[str]]]:
    """(memory name, scoped, missing checks) for every marked entry with a stale check.

    An entry whose memory names no check at all is reported with an empty list: a
    marker with nothing behind it cannot be resolved, and the reader should know that
    rather than take the marker on faith.
    """
    try:
        index_text = (memories / "MEMORY.md").read_text()
    except OSError:
        return []
    findings = []
    for name, scoped in index_entries(index_text):
        try:
            text = (memories / name).read_text()
        except OSError:
            continue  # a dangling index link is a different defect, not this one
        missing, resolved = stale_checks(text, repo, also)
        if missing or not resolved:
            findings.append((name, scoped, missing))
    return findings


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
    # Slug from the main checkout so a worktree session finds the memories; `repo`
    # itself stays the yardstick for path existence below.
    primary = main_checkout(repo)
    memories = memory_dir(config_dir, primary)
    if memories is None:
        return 0
    # None when already in the main checkout, so the second existence test is skipped
    # rather than repeated against the same tree.
    also = primary if primary != repo else None

    findings = []
    for path in sorted(memories.glob("*.md")):
        if path.name == "MEMORY.md":
            continue  # the index: it links memories, it does not describe code
        try:
            text = path.read_text()
        except OSError:
            continue
        gone = stale_paths(text, repo, also)
        if gone:
            findings.append((path.name, gone))

    # Silent when there is nothing to say. This runs at every session start, where an
    # all-clear line every time is the fastest way to train someone to stop reading.
    if findings:
        subject = "memory names" if len(findings) == 1 else "memories name"
        print(
            f"{len(findings)} {subject} a path that no longer exists — check whether "
            "the memory is stale or the file simply moved:"
        )
        for name, gone in findings[:MAX_REPORTED]:
            print(f"  {name}: {', '.join(gone)}")
        if len(findings) > MAX_REPORTED:
            print(f"  ... and {len(findings) - MAX_REPORTED} more")

    # The index pass: the skip above still stands for the path scan, because the index
    # links memories rather than describing code. Here it is read for its markers, and
    # the linked memory for the check the marker stands on.
    enforced = enforced_findings(memories, repo, also)
    if enforced:
        subject = "entry names" if len(enforced) == 1 else "entries name"
        print(
            f"{len(enforced)} [ENFORCED]/(SCOPED) index {subject} a check that no "
            "longer resolves:"
        )
        for name, scoped, missing in enforced[:MAX_REPORTED]:
            what = ", ".join(missing) if missing else "no check named"
            if scoped:
                verdict = "SCOPED: repoint, keep the body"
            else:
                verdict = "pointer-only: repoint if the check moved, retire if gone"
            print(f"  {name}: {what} ({verdict})")
        if len(enforced) > MAX_REPORTED:
            print(f"  ... and {len(enforced) - MAX_REPORTED} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
