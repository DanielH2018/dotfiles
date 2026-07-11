#!/usr/bin/env python3
"""Pre-download everything the index build needs network for, so scheduled/sandboxed
builds run fully offline.

Fetches:
  1. the FastEmbed embedding model (from Hugging Face)
  2. the DuckDB `fts` extension (from extensions.duckdb.org)

Run once on any machine (or as a Docker build layer) with network available:

    uv run python scripts/prefetch.py

After this, `vault-index build` / `query` need no network.
"""

from __future__ import annotations

import os
import sys

# Force online — this script's whole job is the one-time download.
os.environ["HF_HUB_OFFLINE"] = "0"

from vault_index.config import MODEL_NAME
from vault_index.embedder import Embedder


def main() -> int:
    print(f"prefetch: embedding model {MODEL_NAME} …", flush=True)
    # embedding one string forces the model download + load
    Embedder(MODEL_NAME).embed_documents(["warm the cache"])
    print("prefetch: model cached", flush=True)

    print("prefetch: DuckDB fts extension …", flush=True)
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL fts")
    con.execute("LOAD fts")
    con.close()
    print("prefetch: fts cached", flush=True)

    print("prefetch: done — builds can now run offline", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
