#!/usr/bin/env python3
"""Generate a curated vault index from an allowlist.

Usage: gen-vault-index.py <vault_dir> <allowlist_file> <output_file>

Walks each allowlisted path (file or dir) under vault_dir, reads each Markdown
file's frontmatter title/summary, and writes a compact index (one line per
page, grouped by top-level folder). Only allowlisted pages appear — never the
vault's real index.md or CLAUDE.md.
"""
import os
import sys

SKIP_BASENAMES = ("CLAUDE.md", "index.md")


def parse_frontmatter(path):
    """Return (title, summary) from a note's YAML frontmatter, best-effort."""
    title = summary = ""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        return title, summary
    if not text.startswith("---"):
        return title, summary
    end = text.find("\n---", 3)
    if end == -1:
        return title, summary
    for line in text[3:end].splitlines():
        if line.startswith("title:"):
            title = line[len("title:"):].strip()
        elif line.startswith("summary:"):
            summary = line[len("summary:"):].strip()
    return title, summary


def collect_md_files(vault_dir, entry):
    """Resolve an allowlist entry to a sorted list of .md files under vault_dir."""
    abspath = os.path.join(vault_dir, entry)
    if os.path.isfile(abspath) and abspath.endswith(".md"):
        return [abspath]
    files = []
    if os.path.isdir(abspath):
        for root, _dirs, names in os.walk(abspath):
            for name in names:
                if name.endswith(".md") and name not in SKIP_BASENAMES:
                    files.append(os.path.join(root, name))
    return sorted(files)


def read_allowlist(allowlist_file):
    entries = []
    with open(allowlist_file, encoding="utf-8") as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if os.path.basename(line) in SKIP_BASENAMES:
                continue
            entries.append(line)
    return entries


def build_index(vault_dir, entries):
    """Return markdown listing allowlisted pages grouped by top-level folder."""
    groups = {}
    for entry in entries:
        for md in collect_md_files(vault_dir, entry):
            rel = os.path.relpath(md, vault_dir)
            top = rel.split(os.sep)[0] if os.sep in rel else "(root)"
            _title, summary = parse_frontmatter(md)
            name = os.path.splitext(os.path.basename(md))[0]
            line = f"- [[{name}]] — {summary}" if summary else f"- [[{name}]]"
            groups.setdefault(top, []).append(line)
    out = [
        "---",
        "title: Vault Index (sandbox curated view)",
        "summary: Curated read-only subset of the vault mounted into this sandbox",
        "---",
        "",
        "# Vault Index (curated)",
        "",
        "Read-only, partial view — only the pages below exist in this sandbox.",
        "",
    ]
    for top in sorted(groups):
        out.append(f"## {top}")
        out.extend(sorted(groups[top]))
        out.append("")
    return "\n".join(out)


def main():
    if len(sys.argv) != 4:
        sys.stderr.write(
            "usage: gen-vault-index.py <vault_dir> <allowlist_file> <output_file>\n"
        )
        return 2
    vault_dir, allowlist_file, output_file = sys.argv[1:4]
    entries = read_allowlist(allowlist_file)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(build_index(vault_dir, entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
