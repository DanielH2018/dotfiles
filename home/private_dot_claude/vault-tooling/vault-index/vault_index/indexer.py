"""DuckDB store: build and incrementally update the chunk index + FTS."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import duckdb

from .chunker import chunk_vault
from .config import Config
from .embedder import Embedder

_EMBED_BATCH = 64


@dataclass
class BuildStats:
    files: int
    total_chunks: int
    embedded: int
    skipped: int
    deleted: int


def _connect(config: Config) -> duckdb.DuckDBPyConnection:
    config.index_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(config.index_path))
    con.execute("INSTALL fts")
    con.execute("LOAD fts")
    con.execute(
        f"""
        CREATE TABLE IF NOT EXISTS chunks (
            id VARCHAR PRIMARY KEY,
            path VARCHAR,
            title VARCHAR,
            tags VARCHAR,
            heading VARCHAR,
            text VARCHAR,
            content_hash VARCHAR,
            mtime DOUBLE,
            embedding FLOAT[{config.embed_dim}]
        )
        """
    )
    con.execute(
        "CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)"
    )
    return con


def _recreate_fts(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        "PRAGMA create_fts_index('chunks', 'id', 'text', stemmer='porter', overwrite=1)"
    )


def build(config: Config, embedder: Embedder | None = None, full: bool = False) -> BuildStats:
    embedder = embedder or Embedder(config.model_name)
    con = _connect(config)
    try:
        if full:
            con.execute("DELETE FROM chunks")

        existing = dict(con.execute("SELECT id, content_hash FROM chunks").fetchall())

        current = list(chunk_vault(config))
        current_ids = {c.id for c in current}
        files = len({c.path for c in current})

        to_embed = [
            c for c in current
            if existing.get(c.id) != c.content_hash
        ]
        to_delete = [cid for cid in existing if cid not in current_ids]
        # ids being rewritten must be removed first (no upsert on ARRAY columns).
        rewrite_ids = [c.id for c in to_embed if c.id in existing]

        for cid in to_delete + rewrite_ids:
            con.execute("DELETE FROM chunks WHERE id = ?", [cid])

        # Batch similar-length chunks together: FastEmbed pads each batch to its
        # longest member, so length-bucketing avoids short chunks paying long ones' cost.
        to_embed.sort(key=lambda c: len(c.text))
        for start in range(0, len(to_embed), _EMBED_BATCH):
            batch = to_embed[start:start + _EMBED_BATCH]
            vectors = embedder.embed_documents([c.text for c in batch])
            con.executemany(
                f"""
                INSERT INTO chunks
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS FLOAT[{config.embed_dim}]))
                """,
                [
                    [c.id, c.path, c.title, c.tags, c.heading, c.text,
                     c.content_hash, c.mtime, vec]
                    for c, vec in zip(batch, vectors)
                ],
            )

        _recreate_fts(con)

        con.execute(
            "INSERT OR REPLACE INTO meta VALUES ('model', ?), ('last_build', ?)",
            [config.model_name, datetime.now().isoformat(timespec="seconds")],
        )

        return BuildStats(
            files=files,
            total_chunks=len(current),
            embedded=len(to_embed),
            skipped=len(current) - len(to_embed),
            deleted=len(to_delete),
        )
    finally:
        con.close()


def status(config: Config) -> dict:
    if not config.index_path.exists():
        return {"exists": False, "index_path": str(config.index_path)}
    con = duckdb.connect(str(config.index_path))
    try:
        chunks = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
        files = con.execute("SELECT count(DISTINCT path) FROM chunks").fetchone()[0]
        meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    finally:
        con.close()
    return {
        "exists": True,
        "index_path": str(config.index_path),
        "chunks": chunks,
        "files": files,
        "model": meta.get("model"),
        "last_build": meta.get("last_build"),
    }
