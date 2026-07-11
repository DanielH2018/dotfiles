"""Hybrid search: cosine + BM25, fused with Reciprocal Rank Fusion."""

from __future__ import annotations

from dataclasses import dataclass

import duckdb

from .config import RRF_K, Config
from .embedder import Embedder


@dataclass
class Result:
    path: str
    title: str
    heading: str
    score: float
    snippet: str


def rrf_fuse(ranked_lists: list[list[str]], k: int = RRF_K) -> dict[str, float]:
    """Reciprocal Rank Fusion. Each list is ids in rank order (best first)."""
    scores: dict[str, float] = {}
    for ids in ranked_lists:
        for rank, cid in enumerate(ids):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank + 1)
    return scores


def _snippet(text: str, limit: int = 240) -> str:
    body = text.split("\n\n", 1)[-1].strip().replace("\n", " ")
    return body[:limit] + ("…" if len(body) > limit else "")


def search(config: Config, query_text: str, k: int = 8,
           embedder: Embedder | None = None) -> list[Result]:
    embedder = embedder or Embedder(config.model_name)
    # read_only so the index can live on a read-only mount (sandbox curated view).
    con = duckdb.connect(str(config.index_path), read_only=True)
    try:
        con.execute("LOAD fts")
        if con.execute("SELECT count(*) FROM chunks").fetchone()[0] == 0:
            raise RuntimeError("index empty — run `vault-index build` first")

        pool = k * 5
        qvec = embedder.embed_query(query_text)
        vec_ids = [
            row[0] for row in con.execute(
                f"""
                SELECT id, array_cosine_similarity(embedding, CAST(? AS FLOAT[{config.embed_dim}])) AS sim
                FROM chunks ORDER BY sim DESC LIMIT ?
                """,
                [qvec, pool],
            ).fetchall()
        ]
        bm25_ids = [
            row[0] for row in con.execute(
                """
                SELECT id, fts_main_chunks.match_bm25(id, ?) AS s
                FROM chunks WHERE s IS NOT NULL ORDER BY s DESC LIMIT ?
                """,
                [query_text, pool],
            ).fetchall()
        ]

        fused = rrf_fuse([vec_ids, bm25_ids])
        if not fused:
            return []

        ids = list(fused)
        rows = con.execute(
            f"SELECT id, path, title, heading, text FROM chunks WHERE id IN ({','.join('?' * len(ids))})",
            ids,
        ).fetchall()
        by_id = {r[0]: r for r in rows}

        # collapse to best-scoring chunk per file
        best_per_file: dict[str, tuple[float, tuple]] = {}
        for cid in sorted(fused, key=lambda c: fused[c], reverse=True):
            row = by_id.get(cid)
            if row is None:
                continue
            path = row[1]
            if path not in best_per_file:
                best_per_file[path] = (fused[cid], row)

        results = [
            Result(path=row[1], title=row[2], heading=row[3], score=score,
                   snippet=_snippet(row[4]))
            for score, row in sorted(best_per_file.values(), key=lambda x: x[0], reverse=True)
        ]
        return results[:k]
    finally:
        con.close()
