from dataclasses import replace

from vault_index.chunker import (
    _parse_frontmatter,
    _parse_tags,
    _split_headings,
    chunk_vault,
)


def test_parse_frontmatter_extracts_fields_and_body():
    raw = "---\ntitle: Foo\ntags: [a, b]\n---\nbody text\n"
    fields, body = _parse_frontmatter(raw)
    assert fields["title"] == "Foo"
    assert fields["tags"] == "[a, b]"
    assert body.strip() == "body text"


def test_parse_frontmatter_missing_returns_whole_body():
    raw = "no frontmatter here"
    fields, body = _parse_frontmatter(raw)
    assert fields == {}
    assert body == raw


def test_parse_tags():
    assert _parse_tags("[ops, incident, settlement]") == "ops,incident,settlement"
    assert _parse_tags("") == ""


def test_split_headings_intro_and_sections():
    body = "intro para\n\n## First\nsection one\n\n## Second\nsection two"
    sections = _split_headings(body)
    headings = [h for h, _ in sections]
    assert headings == ["", "First", "Second"]
    assert sections[1][1] == "section one"


def test_content_hash_is_stable(fixture_config):
    a = {c.id: c.content_hash for c in chunk_vault(fixture_config)}
    b = {c.id: c.content_hash for c in chunk_vault(fixture_config)}
    assert a == b and len(a) > 0


def test_chunk_vault_walks_include_dirs(fixture_config):
    paths = {c.path for c in chunk_vault(fixture_config)}
    assert any("incident_settlement_retry.md" in p for p in paths)
    assert any("service_ledger.md" in p for p in paths)
    assert any("person_alex.md" in p for p in paths)


def test_include_paths_restricts_to_single_file(fixture_config):
    cfg = replace(fixture_config, include_paths=("Work/service_ledger.md",))
    paths = {c.path for c in chunk_vault(cfg)}
    assert paths == {"Work/service_ledger.md"}


def test_include_paths_dir_entry_pulls_all_md(fixture_config):
    cfg = replace(fixture_config, include_paths=("Ops",))
    paths = {c.path for c in chunk_vault(cfg)}
    assert paths and all(p.startswith("Ops/") for p in paths)
    # allowlist boundary: nothing outside the listed entry leaks in
    assert not any("service_ledger" in p or "person_alex" in p for p in paths)


def test_chunk_composed_text_includes_title(fixture_config):
    chunks = [c for c in chunk_vault(fixture_config)
              if "incident_settlement_retry" in c.path]
    assert chunks
    assert all(c.text.startswith("Settlement Retry Race Incident") for c in chunks)
