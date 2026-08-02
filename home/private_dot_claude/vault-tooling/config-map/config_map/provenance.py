"""What can be learned about a config file by looking at it.

Where it came from -- chezmoi source, work-config symlink, the vault, or nothing
that manages it -- plus the frontmatter, leading comment and JSON body that give
it a purpose. Split out of scan.py, which is a catalogue of scanners over the
categories in SPEC.md and calls these once per file it finds.

These are generic over a path: none of them knows what a hook or a skill is.
That is the line between the two modules.
"""

from __future__ import annotations

import json
from pathlib import Path

from .sources import (
    CHEZMOI_ROOT,
    CHEZMOI_TEMPLATING_PREFIXES,
    CHEZMOI_TEMPLATING_SUFFIX,
    CLAUDE_DIR,
    VAULT_ROOT,
    WORK_CONFIG_ROOT,
)


def read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def is_relative_to(path: Path, other: Path) -> bool:
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False


def chezmoi_source_for(deployed: Path) -> Path | None:
    try:
        rel = deployed.relative_to(CLAUDE_DIR)
    except ValueError:
        return None
    if not rel.parts:
        return None
    *parent_parts, last = rel.parts
    candidates = [CHEZMOI_ROOT.joinpath(*rel.parts)]
    candidates.append(CHEZMOI_ROOT.joinpath(*parent_parts, "executable_" + last))
    candidates.append(CHEZMOI_ROOT.joinpath(*parent_parts, last + CHEZMOI_TEMPLATING_SUFFIX))
    for prefix in CHEZMOI_TEMPLATING_PREFIXES:
        candidates.append(CHEZMOI_ROOT.joinpath(*parent_parts, prefix + last))
        candidates.append(CHEZMOI_ROOT.joinpath(*parent_parts, f"{prefix}{last}.sh{CHEZMOI_TEMPLATING_SUFFIX}"))
        candidates.append(CHEZMOI_ROOT.joinpath(*parent_parts, prefix + last + CHEZMOI_TEMPLATING_SUFFIX))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _is_generated_source(source: Path) -> bool:
    name = source.name
    if name.endswith(CHEZMOI_TEMPLATING_SUFFIX):
        return True
    return any(name.startswith(prefix) for prefix in CHEZMOI_TEMPLATING_PREFIXES)


def provenance_for(deployed: Path) -> tuple[str, str]:
    """SPEC.md §4 provenance detection, in order: project → symlink(work) → chezmoi → unmanaged."""
    if is_relative_to(deployed, VAULT_ROOT):
        return "project", str(deployed)
    if not deployed.exists() and not deployed.is_symlink():
        return "unmanaged", ""
    if deployed.is_symlink():
        target = deployed.resolve()
        if is_relative_to(target, WORK_CONFIG_ROOT):
            return "work", str(target)
        return "unmanaged", str(target)
    source = chezmoi_source_for(deployed)
    if source is not None:
        return ("generated" if _is_generated_source(source) else "chezmoi"), str(source)
    return "unmanaged", ""


def frontmatter_field(path: Path, name: str) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    block_lines = text[3:end].splitlines()
    for i, line in enumerate(block_lines):
        stripped = line.strip()
        if not stripped.startswith(f"{name}:"):
            continue
        value = stripped[len(name) + 1 :].strip()
        if value in ("|", "|-", ">", ">-"):
            # YAML block scalar: the value is the indented lines that follow.
            continuation = []
            for cont in block_lines[i + 1 :]:
                if cont.strip() == "":
                    continue
                if cont[:1] in (" ", "\t"):
                    continuation.append(cont.strip())
                else:
                    break
            return " ".join(continuation) or None
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        return value
    return None


def leading_comment(path: Path) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in lines[:15]:
        stripped = line.strip()
        if stripped.startswith("#!"):
            continue
        if stripped.startswith("#"):
            text = stripped.lstrip("#").strip()
            # Skip a comment that just echoes the filename (e.g. "# foo.sh") — not a purpose.
            if text and text not in (path.name, path.stem):
                return text
        elif stripped:
            break
    return None


def humanize_filename(path: Path) -> str:
    return path.stem.replace("_", " ").replace("-", " ").strip().capitalize()


def purpose_for(path: Path) -> str:
    return frontmatter_field(path, "description") or humanize_filename(path)
