#!/usr/bin/env python3
"""Survey a project's Claude memory store: what it costs, and what nothing reads.

The memory index (`MEMORY.md`) is injected verbatim into every session, so every
pointer line is charged every time. The line cap in the SessionStart hook bounds how
much gets *written*; it says nothing about whether what was written still earns its
injection. This script supplies the evidence that judgement needs, and deliberately
makes no judgement itself:

  * bytes and an estimated token cost for the injected index, and for the whole store
  * pointer lines that name a file which does not exist (a dead link in the index)
  * targets the index links more than once
  * memory files nothing in the index points at (an orphan nothing will ever surface)
  * per-file last-reference date, from scanning session transcripts for the file's slug
  * near-duplicate candidates, by shingled-token overlap between file bodies
  * archived memories whose `promoted_to:` or `enforced_by:` owner no longer resolves

Every number here is a *proxy*. `/context` reports the real token share and this does
not; a transcript scan finds a slug that was mentioned, which is weaker than one that
was acted on. Both are still far better than a line count, which is what the cap
measures.

A survey writes nothing. The consolidation pass that consumes its output proposes a
diff for review rather than editing the store, because several worktree sessions append
to `MEMORY.md` concurrently and a scheduled writer would race them.

One flag writes: `--write-archive-table` replaces the owner table in
`archive/README.md` with one built from the archived files' `promoted_to:` and
`enforced_by:` keys. No session appends to that file. The table sits between two marker
lines, and the prose around them stays as written.

Run it from inside the project whose memory you want surveyed. The memory and
transcript directories are derived from that project's path, and cited check paths
resolve against its default branch. Each has a flag to override it.

The path and index judgements come from hooks/lib/memory_resolver.py, the module the
SessionStart hook memory-upkeep.py also uses, so the survey and the hook agree. A cited
check or an index link into the repo is gone when the default branch deleted it, even
though a checkout that lags still holds the file. A path the default branch never
tracked counts as present while any checkout of the repo holds it. `index_state` also
reports an `enforced_by:` key that disagrees with the index. The hook prints that
finding, and the survey leaves it out.

Usage:
    python3 ~/.claude/skills/memory-consolidation/memory_survey.py
    python3 ~/.claude/skills/memory-consolidation/memory_survey.py --memory-dir DIR
    python3 ~/.claude/skills/memory-consolidation/memory_survey.py --repo-root DIR
    python3 ~/.claude/skills/memory-consolidation/memory_survey.py --json
    python3 ~/.claude/skills/memory-consolidation/memory_survey.py --write-archive-table

Exit code is 0 for a clean survey and 1 when it finds a dead index link, so it is usable
as a gate. Orphans and stale files are reported but never fail the run: they are input
to a judgement call, not defects.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# The resolver lives with the hooks: <config root>/hooks/lib is two directories above
# this file in the chezmoi source tree and in ~/.claude alike.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hooks" / "lib"))
from memory_resolver import (  # noqa: E402
    INDEX_LINK,
    ArchivedOwner,
    Tree,
    archived_owners,
    index_state,
    main_checkout,
)


def _local_datetime(epoch: float) -> _dt.datetime:
    """An aware datetime in this machine's zone: transcripts are local files."""
    return _dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc).astimezone()


def _git(cwd: Path, *args: str) -> str | None:
    """Stdout of one git command run in `cwd`, or None when git fails or is silent."""
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
        )
    except OSError:
        return None
    out = result.stdout.strip()
    return out if result.returncode == 0 and out else None


def checkout_root(cwd: Path) -> Path:
    """The checkout `Tree` is built around when it resolves a memory's cited paths.

    This is the checkout `cwd` sits in, worktree included. `Tree` reads the default
    branch first and every other checkout of the repo after it, so a check added on this
    branch counts as present until the default branch tracks it and then deletes it.
    Falls back to `cwd` itself outside a git repository.
    """
    top = _git(cwd, "rev-parse", "--show-toplevel")
    return Path(top) if top else cwd


def project_slug(project: Path) -> str:
    """Claude Code's directory name for a project under ~/.claude/projects.

    The encoding replaces every character that is not a letter or a digit with a dash,
    so /home/ubuntu/server becomes -home-ubuntu-server and a dotted path such as
    /home/ubuntu/.local/share/chezmoi becomes -home-ubuntu--local-share-chezmoi.
    Derived rather than searched: a search would pick up another project's memories
    when two are open at once.
    """
    return re.sub(r"[^A-Za-z0-9]", "-", str(project))


def default_dirs(cwd: Path, home: Path | None = None) -> tuple[Path, Path]:
    """The (memory, transcript) directories of the project `cwd` belongs to.

    Args:
        cwd: a directory inside the project, which may be a linked worktree.
        home: the home directory holding `.claude/projects`; None reads `Path.home()`.
    """
    base = home if home is not None else Path.home()
    transcripts = (
        base / ".claude" / "projects" / project_slug(main_checkout(checkout_root(cwd)))
    )
    return transcripts / "memory", transcripts


# Rough characters-per-token for English prose. Only ever used to turn bytes into an
# order-of-magnitude token figure; it is not a tokenizer and does not pretend to be.
_CHARS_PER_TOKEN = 4

# Shingle width for near-duplicate detection. Four words is long enough that ordinary
# shared vocabulary ("the deploy fails when") does not match by accident, and short
# enough that two entries describing one fact in different sentences still overlap.
_SHINGLE = 4

# A transcript line naming more slugs than this is the injected index, not a citation.
# Five is comfortably above what a sentence citing related memories does (the index's
# own prose groups link two or three) and far below the ~100 a full injection carries.
_BULK_SLUG_LINE = 5


def _read(path: Path) -> str:
    """Read a file as text, tolerating the odd non-UTF-8 byte rather than failing."""
    return path.read_text(encoding="utf-8", errors="replace")


def _est_tokens(n_bytes: int) -> int:
    return n_bytes // _CHARS_PER_TOKEN


def _body_words(path: Path) -> list[str]:
    """Lowercased word tokens of a memory file's body, with YAML frontmatter removed.

    Frontmatter carries `name:`/`description:` that restate the body, so leaving it in
    would inflate every pairwise overlap by a constant and flatten the ranking.
    """
    text = _read(path)
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) == 3:
            text = parts[2]
    return re.findall(r"[a-z0-9_]+", text.lower())


def _shingles(words: list[str], width: int = _SHINGLE) -> set[tuple[str, ...]]:
    if len(words) < width:
        return set()
    return {tuple(words[i : i + width]) for i in range(len(words) - width + 1)}


def duplicate_candidates(
    files: list[Path], threshold: float = 0.12, limit: int = 20
) -> list[tuple[str, str, float]]:
    """Rank file pairs by Jaccard overlap of their body shingles, descending.

    The threshold is deliberately low. This produces *candidates* for a reader to judge,
    and a merge decision that a human or a model makes from the text is cheap, where a
    missed duplicate stays in the store for months.
    """
    shingles = {f.name: _shingles(_body_words(f)) for f in files}
    pairs: list[tuple[str, str, float]] = []
    names = sorted(shingles)
    for i, a in enumerate(names):
        sa = shingles[a]
        if not sa:
            continue
        for b in names[i + 1 :]:
            sb = shingles[b]
            if not sb:
                continue
            union = len(sa | sb)
            if not union:
                continue
            score = len(sa & sb) / union
            if score >= threshold:
                pairs.append((a, b, round(score, 3)))
    pairs.sort(key=lambda p: p[2], reverse=True)
    return pairs[:limit]


def _assistant_text(line: str) -> str:
    """Return the assistant's own words from one transcript record, or "" otherwise.

    A transcript record is a JSON object whose `message.content` is a list of blocks.
    Only `text` and `thinking` blocks are the model speaking; `tool_use` and
    `tool_result` blocks carry command output, which names memory files without citing
    them.
    """
    try:
        rec = json.loads(line)
    except (ValueError, TypeError):
        return ""
    if not isinstance(rec, dict) or rec.get("type") != "assistant":
        return ""
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [
        block.get("text") or block.get("thinking") or ""
        for block in content
        if isinstance(block, dict) and block.get("type") in ("text", "thinking")
    ]
    return "\n".join(p for p in parts if p)


def transcript_dirs(transcript_dir: Path) -> list[Path]:
    """`transcript_dir` and the transcript directories of the project's worktrees.

    Claude Code names a session's transcript directory after the session's working
    directory. A session in a linked worktree at `<project>/.claude/worktrees/<name>`
    writes under `<slug>--claude-worktrees-<name>`, a sibling of the project's own
    directory. Most sessions on a repo with parallel worktree work run there, so a scan
    of the project directory alone reads nearly every entry as unreferenced: measured
    on the homelab store on 2026-10-03, 55 of 62 entries. A worktree session's memory
    is still keyed to the primary checkout, so only its transcripts need gathering.
    """
    worktrees = transcript_dir.parent.glob(f"{transcript_dir.name}--claude-worktrees-*")
    return [transcript_dir, *sorted(p for p in worktrees if p.is_dir())]


def last_referenced(
    files: list[Path], transcript_dir: Path, days: int, now: float | None = None
) -> dict[str, str | None]:
    """Map each memory filename to the most recent transcript date naming its slug.

    A memory's slug is its filename without `.md`. Sessions cite a memory by that slug
    (the `name:` field and the index link agree with it), so searching for it is a sound
    test for "something surfaced this". It cannot distinguish a memory that was surfaced
    from one that was acted on. That distinction needs the model, and this is the
    mechanical half.

    Only `assistant` records are searched, and within them only text and thinking.
    Everything else in a transcript names slugs without citing them: the injected index
    arrives as an attachment, a directory listing of the store arrives as a tool result,
    and both would mark every entry referenced on the day someone merely looked at the
    folder. Measured on the homelab store, the naive whole-line scan reported all 107
    entries as referenced today. A signal that returns "everything is live" regardless
    of input is not a signal.

    Transcripts are scanned line by line and matched against every slug in one pass,
    because the store is ~100 files against ~800 MB of transcripts: re-reading per file
    would be a hundred passes over the same bytes.

    A line naming more than `_BULK_SLUG_LINE` slugs is skipped. `MEMORY.md` is injected
    verbatim into every session and therefore lands in every transcript, so without
    this every indexed entry reads as referenced today and the signal measures nothing
    but the injection itself. A real citation names one or two slugs; the index names a
    hundred in one blob. This is the difference between "something surfaced this entry"
    and "the index that lists it was pasted in again", and only the first is evidence
    the entry earns its place.

    A subagent's transcript sits at `<session>/subagents/*.jsonl` beside its parent's
    and is scanned with it; its records have the same shape. A subagent may cite an
    entry only because its brief named it, and that still counts: the parent passed the
    brief in a `tool_use` block, which the scan skips, so the subagent's reply is the
    only scanned trace of the parent's citation. Measured on the homelab store on
    2026-10-03, including them took the unreferenced count from 54 to 52.
    """
    result: dict[str, str | None] = {f.name: None for f in files}

    if now is None:
        now = _dt.datetime.now(tz=_dt.timezone.utc).timestamp()
    cutoff = now - days * 86400
    slugs = {f.stem: f.name for f in files}

    transcripts = [
        p
        for d in transcript_dirs(transcript_dir)
        if d.is_dir()
        for pattern in ("*.jsonl", "*/subagents/*.jsonl")
        for p in d.glob(pattern)
        if p.is_file() and p.stat().st_mtime >= cutoff
    ]
    # Newest first, so the first hit for a slug is its most recent reference and later
    # transcripts for that slug can be skipped.
    transcripts.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    outstanding = set(slugs)
    for tpath in transcripts:
        if not outstanding:
            break
        day = _local_datetime(tpath.stat().st_mtime).strftime("%Y-%m-%d")
        try:
            with tpath.open("r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if not outstanding:
                        break
                    text = _assistant_text(line)
                    if not text:
                        continue
                    hits = [slug for slug in outstanding if slug in text]
                    if len(hits) > _BULK_SLUG_LINE:
                        continue
                    for slug in hits:
                        result[slugs[slug]] = day
                        outstanding.discard(slug)
        except OSError:
            # An unreadable transcript is missing evidence, not a survey failure.
            # Leaving the slug outstanding makes it look unreferenced, which is the
            # safe direction: it surfaces for review rather than being silently retired.
            continue
    return result


# A path that looks like a check a repo could own. The shapes are the homelab repo's
# test and validator layout plus `.claude/hooks/`. Deliberately narrow: a memory naming
# `ansible/roles/k8s/traefik/templates/deployment.yaml.j2` is citing the thing it
# describes, not a check that enforces it.
_CHECK_PATH = re.compile(
    r"(?:ansible/tests/[\w./-]+\.py"
    r"|scripts/[\w./-]*test_[\w./-]+\.py"
    r"|scripts/validate/[\w./-]+\.py"
    r"|\.claude/hooks/[\w./-]+\.(?:py|sh)"
    r"|[\w./-]*files/test_[\w./-]+\.py)"
)


def _resolves(cited: str, tree: Tree) -> bool:
    """Whether a cited check path exists, in the repo OR the user's `~/.claude` tree.

    `tree` judges the repo by its default branch, so a check the default branch deleted
    is gone although a checkout that lags still holds it.

    `.claude/hooks/` is the one prefix that lives in both places: a repo can have its
    own hooks, and chezmoi deploys others to `~/.claude/hooks/`. Resolving against the
    repo alone reports a hook that exists as DANGLING, which is the survey's loudest
    verdict. Claiming a memory has lost its enforcer when it has not is worse than not
    counting it at all.
    """
    if tree.holds(cited):
        return True
    return cited.startswith(".claude/") and (Path.home() / cited).exists()


# `enforceable: no` in a memory's frontmatter, with the reason on the same line. Matched
# textually rather than by parsing YAML, so the survey stays stdlib-only.
_ENFORCEABLE_NO = re.compile(
    r"^\s*enforceable:\s*(?:no|false)\b\s*(?:[-—:]\s*(?P<reason>.+?))?\s*$",
    re.MULTILINE | re.IGNORECASE,
)


def _frontmatter(text: str) -> str:
    """The YAML frontmatter block, or "" when the file has none.

    Read separately from the body so a `enforceable: no` written in prose (quoting this
    convention, say) cannot change a memory's bucket.
    """
    if not text.startswith("---"):
        return ""
    parts = text.split("---", 2)
    return parts[1] if len(parts) == 3 else ""


def declared_unenforceable(text: str) -> tuple[bool, str]:
    """Whether the frontmatter declares `enforceable: no`, and the reason given.

    The reason is REQUIRED. A bare `enforceable: no` is reported as a defect rather than
    honoured: without one, the field becomes a way to retire any memory that looks hard,
    and the bucket it feeds is the one nobody is expected to act on.
    """
    match = _ENFORCEABLE_NO.search(_frontmatter(text))
    if not match:
        return False, ""
    return True, (match.group("reason") or "").strip()


def enforcement(files: list[Path], tree: Tree) -> dict[str, list[str]]:
    """Which memory files name a check that exists, which name none, which never can.

    The escalation ladder is run-local note -> memory -> CLAUDE.md rule -> executable
    check, and MEMORY.md marks a handful of entries ENFORCED. Nothing counted the rest,
    so the ladder was aspirational: there was no way to ask which memories are still
    carried by an agent remembering them.

    This is a PROXY, and a deliberately weak one. It reports whether a memory cites a
    check path that resolves, which is evidence the fact has an owner, not proof the
    check tests what the memory claims. A cited path that no longer exists is the more
    interesting half: the memory says it is enforced and the enforcer is gone.

    WHY A FOURTH BUCKET. Some memories are judgment ("a skeptic resolves uncertainty
    downward"), a ledger, or a measurement, and no check will ever own them. Counting
    those in the denominator makes the ratio imply a backlog that does not exist, and a
    number nobody can act on is worse than no number. `enforceable: no` in the
    frontmatter moves one out of the denominator. The reason is required, and a memory
    that declares it while ALSO citing a live check is reported as a contradiction
    rather than silently believed.
    """
    enforced, unenforced, dangling = [], [], []
    not_enforceable, contradictions = [], []
    for path in files:
        text = _read(path)
        cited = sorted(set(_CHECK_PATH.findall(text)))
        resolved = [c for c in cited if _resolves(c, tree)]
        declared, reason = declared_unenforceable(text)

        # A ledger cites checks as EVIDENCE for the findings it records, never as its
        # own enforcer, and `_CHECK_PATH` cannot tell the two apart. Both ledgers in the
        # homelab store read as contradictions on 2026-09-02, and both declarations
        # were correct.
        is_ledger = path.name.startswith("review-") and path.name.endswith("-state.md")

        if declared and resolved and not is_ledger:
            contradictions.append(
                f"{path.name} -> declares enforceable: no, cites {resolved[0]}"
            )
            enforced.append(path.name)
            continue
        if declared and not reason:
            contradictions.append(
                f"{path.name} -> declares enforceable: no with no reason"
            )
            unenforced.append(path.name)
            continue
        if declared:
            not_enforceable.append(f"{path.name} — {reason}")
            continue

        if not cited:
            unenforced.append(path.name)
        elif resolved:
            enforced.append(path.name)
        else:
            dangling.append(f"{path.name} -> {', '.join(cited)}")
    return {
        "enforced": enforced,
        "unenforced": unenforced,
        "dangling": dangling,
        "not_enforceable": not_enforceable,
        "contradictions": contradictions,
    }


TABLE_OPEN = (
    "<!-- generated by memory_survey.py --write-archive-table from each file's "
    "promoted_to: and enforced_by: keys. Edit the keys, not the table. -->"
)
TABLE_CLOSE = "<!-- end generated -->"


def archive_table(owners: list[ArchivedOwner]) -> str:
    """The owner table for archive/README.md, markers included.

    One row per owner key. A row whose owner does not resolve says so, so the table
    never points a reader at a path that is gone.
    """
    rows = ["| memory | owner |", "|---|---|"]
    for o in owners:
        cell = f"`{o.owner}`"
        if o.problem:
            cell += f" (does not resolve: {o.problem})"
        rows.append(f"| `{o.file.removesuffix('.md')}` | {cell} |")
    return "\n".join([TABLE_OPEN, *rows, TABLE_CLOSE])


def _with_table(readme: str, table: str) -> str:
    """`readme` with its generated table replaced by `table`, or `table` appended."""
    start, end = readme.find(TABLE_OPEN), readme.find(TABLE_CLOSE)
    if start != -1 and end > start:
        return readme[:start] + table + readme[end + len(TABLE_CLOSE) :]
    head = readme.rstrip("\n") if readme.strip() else "# Archived memories"
    return f"{head}\n\n## Where each archived claim lives\n\n{table}\n"


def write_archive_table(memory_dir: Path, tree: Tree) -> int:
    """Rewrite the owner table in archive/README.md. Returns the number of rows written.

    A README without the markers gets the table appended under its own heading, and a
    missing README is created. A table that already matches is left untouched.
    """
    owners = archived_owners(memory_dir, tree)
    readme_path = memory_dir / "archive" / "README.md"
    readme = _read(readme_path) if readme_path.exists() else ""
    updated = _with_table(readme, archive_table(owners))
    if updated != readme:
        readme_path.parent.mkdir(exist_ok=True)
        readme_path.write_text(updated, encoding="utf-8", newline="\n")
    return len(owners)


def archive_survey(memory_dir: Path, tree: Tree) -> dict[str, Any]:
    """What the archive's owner keys say, and whether the README's table agrees.

    Returns `files` (archived memories), `owned` (those with an owner key), `stale`
    (one row per owner that does not resolve) and `table_current` (False when the
    README's table differs from what `--write-archive-table` writes).
    """
    owners = archived_owners(memory_dir, tree)
    archive = memory_dir / "archive"
    readme_path = archive / "README.md"
    readme = _read(readme_path) if readme_path.exists() else ""
    return {
        "files": sum(1 for p in archive.glob("*.md") if p.name != "README.md"),
        "owned": len({o.file for o in owners}),
        "stale": [
            f"{o.file}: {o.key} {o.owner}, {o.problem}" for o in owners if o.problem
        ],
        "table_current": archive_table(owners) in readme
        or (not owners and TABLE_OPEN not in readme),
    }


def survey(
    memory_dir: Path,
    transcript_dir: Path,
    transcript_days: int,
    duplicate_threshold: float = 0.12,
    now: float | None = None,
    repo_root: Path | None = None,
) -> dict:
    """Measure the memory store's size, staleness, and index health.

    Reads every `*.md` file in `memory_dir` (except MEMORY.md itself), cross-references
    which are linked from the index and which transcripts under `transcript_dir` cited
    in the last `transcript_days` days, and flags near-duplicate entries and enforcement
    references along the way.

    Args:
        memory_dir: directory holding MEMORY.md and its entry files.
        transcript_dir: directory of session transcripts to scan for citations. The
            transcript directories of the project's worktrees are scanned with it; see
            `transcript_dirs()`.
        transcript_days: how many days back to scan transcripts for citations.
        duplicate_threshold: the similarity ratio above which two entries are flagged
            as near-duplicate candidates.
        now: the epoch the transcript window and the staleness dates are measured
            from; None reads the clock. A test passes a fixed one.
        repo_root: the checkout whose default branch cited check paths resolve against;
            None derives it from the current directory with `checkout_root()`.

    Returns:
        A dict with `index`/`store` size stats, `dead_links`, `orphans`,
        `duplicate_links`, `unreferenced`, `duplicate_candidates`, `enforcement`,
        `archive`, per-file `entries`, and `transcript_window_days`.
    """
    if repo_root is None:
        repo_root = checkout_root(Path.cwd())
    tree = Tree(repo_root, main_checkout(repo_root))
    index_path = memory_dir / "MEMORY.md"
    files = sorted(
        p for p in memory_dir.glob("*.md") if p.is_file() and p.name != "MEMORY.md"
    )

    state = index_state(memory_dir, tree)
    index_text = _read(index_path) if index_path.exists() else ""
    unindexed = set(state.unindexed)

    index_bytes = index_path.stat().st_size if index_path.exists() else 0
    store_bytes = sum(p.stat().st_size for p in files)

    if now is None:
        now = _dt.datetime.now(tz=_dt.timezone.utc).timestamp()
    refs = last_referenced(files, transcript_dir, transcript_days, now=now)
    today = _local_datetime(now).date()

    entries: list[dict[str, Any]] = []
    for p in files:
        seen = refs[p.name]
        age_days = None
        if seen:
            age_days = (today - _dt.date.fromisoformat(seen)).days
        entries.append(
            {
                "file": p.name,
                "bytes": p.stat().st_size,
                "modified": _local_datetime(p.stat().st_mtime).strftime("%Y-%m-%d"),
                "last_referenced": seen,
                "days_since_referenced": age_days,
                "indexed": p.name not in unindexed,
            }
        )
    entries.sort(key=lambda e: e["bytes"], reverse=True)

    return {
        "memory_dir": str(memory_dir),
        "index": {
            "bytes": index_bytes,
            "est_tokens": _est_tokens(index_bytes),
            "pointer_links": len(set(INDEX_LINK.findall(index_text))),
        },
        "store": {
            "files": len(files),
            "bytes": store_bytes,
            "est_tokens": _est_tokens(store_bytes),
        },
        "dead_links": sorted(state.gone),
        "orphans": sorted(state.unindexed),
        "duplicate_links": sorted(state.duplicated),
        "unreferenced": sorted(
            e["file"] for e in entries if e["last_referenced"] is None
        ),
        "duplicate_candidates": duplicate_candidates(files, duplicate_threshold),
        "enforcement": enforcement(files, tree),
        "archive": archive_survey(memory_dir, tree),
        "entries": entries,
        "transcript_window_days": transcript_days,
    }


def _render(s: dict) -> str:
    out: list[str] = []
    idx, store = s["index"], s["store"]
    out.append(f"memory store: {s['memory_dir']}")
    out.append(
        f"  injected index : {idx['bytes']:>8,} bytes  "
        f"(~{idx['est_tokens']:,} tokens, every session)  "
        f"{idx['pointer_links']} links"
    )
    out.append(
        f"  store on disk  : {store['bytes']:>8,} bytes  "
        f"(~{store['est_tokens']:,} tokens) across {store['files']} files"
    )

    if s["dead_links"]:
        out.append(
            f"\nDEAD INDEX LINKS ({len(s['dead_links'])}) — indexed, not on disk:"
        )
        out.extend(f"  {n}" for n in s["dead_links"])

    if s["duplicate_links"]:
        out.append(
            f"\nDUPLICATE INDEX LINKS ({len(s['duplicate_links'])}) — "
            "the index links one target more than once:"
        )
        out.extend(f"  {n}" for n in s["duplicate_links"])

    if s["orphans"]:
        out.append(f"\norphans ({len(s['orphans'])}) — on disk, nothing links to them:")
        out.extend(f"  {n}" for n in s["orphans"])

    win = s["transcript_window_days"]
    if s["unreferenced"]:
        out.append(
            f"\nunreferenced ({len(s['unreferenced'])}) — "
            f"no mention in {win}d of transcripts:"
        )
        out.extend(f"  {n}" for n in s["unreferenced"])

    if s["duplicate_candidates"]:
        out.append(f"\nnear-duplicate candidates ({len(s['duplicate_candidates'])}):")
        out.extend(
            f"  {score:.3f}  {a}  <->  {b}" for a, b, score in s["duplicate_candidates"]
        )

    enf = s["enforcement"]
    total = len(enf["enforced"]) + len(enf["unenforced"]) + len(enf["dangling"])
    out.append(
        f"\nenforcement: {len(enf['enforced'])}/{total} ENFORCEABLE memories cite "
        "a check that exists"
    )
    if enf.get("not_enforceable"):
        out.append(
            f"  not enforceable ({len(enf['not_enforceable'])}) — declared "
            "`enforceable: no`, so they are OUT of the ratio above. Judgment, ledgers "
            "and measurements no check can own:"
        )
        out.extend(f"    {n}" for n in enf["not_enforceable"])
    if enf.get("contradictions"):
        out.append(
            f"  CONTRADICTION ({len(enf['contradictions'])}) — a declaration that "
            "disagrees with the file, so the declaration was NOT honoured:"
        )
        out.extend(f"    {n}" for n in enf["contradictions"])
    if enf["dangling"]:
        out.append(
            f"  DANGLING ({len(enf['dangling'])}) — cites a check that is GONE, so the "
            "memory claims an owner it no longer has (searched the repo, and ~/ for a "
            ".claude path):"
        )
        out.extend(f"    {n}" for n in enf["dangling"])
    if enf["unenforced"]:
        out.append(
            f"  unenforced ({len(enf['unenforced'])}) — carried by an agent "
            "remembering them. Candidates for the next rung of the ladder, not a "
            "defect list:"
        )
        out.extend(f"    {n}" for n in enf["unenforced"])

    arc = s["archive"]
    if arc["files"]:
        out.append(
            f"\narchive: {arc['owned']}/{arc['files']} archived memories name an owner"
        )
        if arc["stale"]:
            out.append(
                f"  OWNER GONE ({len(arc['stale'])}) — the key names an owner that no "
                "longer resolves. Re-point the key, or drop it:"
            )
            out.extend(f"    {n}" for n in arc["stale"])
        if not arc["table_current"]:
            out.append(
                "  the owner table in archive/README.md is out of date: run "
                "memory_survey.py --write-archive-table"
            )

    out.append("\nlargest entries:")
    for e in s["entries"][:15]:
        seen = e["last_referenced"] or "never"
        flag = "" if e["indexed"] else "  [orphan]"
        out.append(f"  {e['bytes']:>7,}b  seen {seen:>10}  {e['file']}{flag}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    """Run `survey` and print it, as text or `--json`.

    Exits 1 when the index links a file that is not on disk (a dead link), 2 when the
    memory directory does not exist, 0 otherwise. Every other finding needs a judgement
    call, not a failing exit.
    """
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--memory-dir",
        type=Path,
        help="the memory store to survey (default: derived from the project path, "
        "~/.claude/projects/<slug>/memory)",
    )
    ap.add_argument(
        "--transcript-dir",
        type=Path,
        help="the session transcripts to scan (default: derived from the project "
        "path, ~/.claude/projects/<slug>); its <slug>--claude-worktrees-* siblings "
        "are scanned with it",
    )
    ap.add_argument(
        "--repo-root",
        type=Path,
        help="the checkout cited check paths resolve against (default: the git "
        "checkout of the current directory, else the current directory)",
    )
    ap.add_argument(
        "--transcript-days",
        type=int,
        default=30,
        help="how far back to scan transcripts for a reference (default: 30)",
    )
    ap.add_argument(
        "--duplicate-threshold",
        type=float,
        default=0.12,
        help="minimum shingle overlap to report a pair as a near-duplicate "
        "(default: 0.12). Lower it to explore a store that reports none: a detector "
        "you cannot tune is one you cannot tell apart from a detector that never "
        "fires.",
    )
    ap.add_argument("--json", action="store_true", help="emit the survey as JSON")
    ap.add_argument(
        "--write-archive-table",
        action="store_true",
        help="rewrite the owner table in archive/README.md from the archived files' "
        "promoted_to: and enforced_by: keys, and run no survey",
    )
    args = ap.parse_args(argv)

    # Resolved here rather than at import, so importing the module runs no git.
    cwd = Path.cwd()
    memory_dir, transcript_dir = args.memory_dir, args.transcript_dir
    if memory_dir is None or transcript_dir is None:
        derived_memory, derived_transcripts = default_dirs(cwd)
        memory_dir = memory_dir or derived_memory
        transcript_dir = transcript_dir or derived_transcripts
    root = args.repo_root if args.repo_root is not None else checkout_root(cwd)

    if not memory_dir.is_dir():
        print(f"no such memory dir: {memory_dir}", file=sys.stderr)
        return 2

    if args.write_archive_table:
        rows = write_archive_table(memory_dir, Tree(root, main_checkout(root)))
        print(f"{memory_dir / 'archive' / 'README.md'}: {rows} owner rows")
        return 0

    s = survey(
        memory_dir,
        transcript_dir,
        args.transcript_days,
        args.duplicate_threshold,
        repo_root=root,
    )
    print(json.dumps(s, indent=2) if args.json else _render(s))

    # Only a dead link is a defect: the index promises a file that is not there, so a
    # session following that pointer gets nothing. Everything else needs a judgement.
    return 1 if s["dead_links"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
