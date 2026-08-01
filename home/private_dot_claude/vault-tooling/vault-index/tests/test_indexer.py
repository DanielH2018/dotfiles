import duckdb
import pytest
from vault_index.indexer import build, status
from vault_index.query import search


def _build_or_skip(config, embedder, **kw):
    try:
        return build(config, embedder=embedder, **kw)
    except duckdb.Error as e:  # fts extension needs network on first use
        pytest.skip(f"duckdb fts extension unavailable offline: {e}")


def test_build_indexes_all_pages(fixture_config, fake_embedder):
    # The build is what's under test here, so this one still pays for a real one.
    stats = _build_or_skip(fixture_config, fake_embedder, full=True)
    assert stats.files == 3
    assert stats.embedded == stats.total_chunks > 0
    st = status(fixture_config)
    assert st["files"] == 3


def test_semantic_query_ranks_incident_first(built_config, fake_embedder):
    results = search(
        built_config,
        "duplicate settlement race under concurrent retries",
        k=3,
        embedder=fake_embedder,
    )
    assert results
    assert "incident_settlement_retry.md" in results[0].path


def test_exact_token_query_finds_ticket(built_config, fake_embedder):
    results = search(built_config, "TICKET-1234", k=3, embedder=fake_embedder)
    assert results
    assert "incident_settlement_retry.md" in results[0].path


def test_incremental_reembeds_nothing_when_unchanged(built_config, fake_embedder):
    stats2 = build(built_config, embedder=fake_embedder)
    assert stats2.embedded == 0
    assert stats2.skipped == stats2.total_chunks


def test_query_empty_index_raises(built_config, fake_embedder):
    # wipe the rows out of the already-built index to simulate an empty one
    con = duckdb.connect(str(built_config.index_path))
    con.execute("DELETE FROM chunks")
    con.close()
    with pytest.raises(RuntimeError, match="index empty"):
        search(built_config, "anything", embedder=fake_embedder)
