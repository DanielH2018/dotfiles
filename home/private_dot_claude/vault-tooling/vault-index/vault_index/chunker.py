"""Walk the vault, parse frontmatter, split pages into chunks by heading."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from .config import Config

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_HEADING_RE = re.compile(r"^##\s+(.*)$", re.MULTILINE)


@dataclass
class Chunk:
    id: str
    path: str  # vault-relative
    title: str
    tags: str  # comma-joined
    heading: str
    text: str  # composed searchable text (title + heading + body)
    content_hash: str
    mtime: float


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    """Return (fields, body). Minimal YAML-ish parse — key: value + tags list."""
    m = _FRONTMATTER_RE.match(raw)
    if not m:
        return {}, raw
    body = raw[m.end():]
    fields: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields, body


def _parse_tags(value: str) -> str:
    value = value.strip().strip("[]")
    parts = [t.strip().strip("'\"") for t in value.split(",")]
    return ",".join(p for p in parts if p)


def _split_headings(body: str) -> list[tuple[str, str]]:
    """Split body into (heading, section_body). Intro (pre-first-##) has heading ''."""
    matches = list(_HEADING_RE.finditer(body))
    if not matches:
        return [("", body.strip())]
    sections: list[tuple[str, str]] = []
    intro = body[: matches[0].start()].strip()
    if intro:
        sections.append(("", intro))
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        sections.append((m.group(1).strip(), body[start:end].strip()))
    return sections


def _subsplit(text: str, cap: int) -> list[str]:
    """Split an oversized section on paragraph boundaries, staying under cap."""
    if len(text) <= cap:
        return [text]
    pieces: list[str] = []
    buf = ""
    for para in text.split("\n\n"):
        if buf and len(buf) + len(para) + 2 > cap:
            pieces.append(buf.strip())
            buf = ""
        buf = f"{buf}\n\n{para}" if buf else para
    if buf.strip():
        pieces.append(buf.strip())
    return pieces


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _iter_allowlist(config: Config) -> Iterator[Path]:
    """Yield .md files from an explicit allowlist of entries (files or dirs)."""
    seen: set[Path] = set()
    for entry in config.include_paths or ():
        target = config.root / entry
        if target.is_file() and target.suffix == ".md":
            candidates = [target]
        elif target.is_dir():
            candidates = sorted(target.rglob("*.md"))
        else:
            continue
        for path in candidates:
            if path.name in config.exclude_files or path in seen:
                continue
            seen.add(path)
            yield path


def _iter_files(config: Config) -> Iterator[Path]:
    if config.include_paths is not None:
        yield from _iter_allowlist(config)
        return
    if config.include_dirs is None:
        # Vault-agnostic default: walk the whole root, minus exclude_dirs/exclude_files.
        if not config.root.is_dir():
            return
        for path in sorted(config.root.rglob("*.md")):
            rel_parts = set(path.relative_to(config.root).parts)
            if rel_parts & set(config.exclude_dirs):
                continue
            if path.name in config.exclude_files:
                continue
            yield path
        return
    for sub in config.include_dirs:
        base = config.root / sub
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md")):
            rel_parts = set(path.relative_to(config.root).parts)
            if rel_parts & set(config.exclude_dirs):
                continue
            if path.name in config.exclude_files:
                continue
            yield path


def chunk_file(path: Path, config: Config) -> Iterator[Chunk]:
    raw = path.read_text(encoding="utf-8")
    rel = str(path.relative_to(config.root))
    mtime = path.stat().st_mtime
    fields, body = _parse_frontmatter(raw)
    title = fields.get("title") or path.stem.replace("_", " ")
    tags = _parse_tags(fields.get("tags", ""))

    seq = 0
    for heading, section in _split_headings(body):
        if not section.strip():
            continue
        for piece in _subsplit(section, config.max_chunk_chars):
            header = " — ".join(p for p in (title, heading) if p)
            text = f"{header}\n\n{piece}" if header else piece
            yield Chunk(
                id=f"{_sha1(rel)}#{seq}",
                path=rel,
                title=title,
                tags=tags,
                heading=heading,
                text=text,
                content_hash=_sha1(text),
                mtime=mtime,
            )
            seq += 1


def chunk_vault(config: Config) -> Iterator[Chunk]:
    for path in _iter_files(config):
        yield from chunk_file(path, config)
