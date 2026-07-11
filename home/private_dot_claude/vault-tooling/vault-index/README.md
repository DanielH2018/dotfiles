# vault-index

Local hybrid-search index over a personal Markdown wiki/vault. Retrieves pages by
**meaning + keyword**, ranked, instead of routing through `index.md` summaries.

Vault-agnostic: it walks whatever directory `--root` / `$VAULT_INDEX_ROOT` /
`$CLAUDE_VAULT_DIR` points at (see "Staying fresh" below) and makes no assumption
about folder naming. If no vault is configured or present, `build`/`query` simply
find nothing to index — they never error.

## Why this exists

A vault's default retrieval often reads `index.md` (one-line `summary:` per page),
then opens the pages whose summaries look relevant. That *summary-string routing*
works at a handful of pages but degrades as the vault grows: summaries collide,
meaning is lost, and there's no ranking. This is the exact gap agentcairn
(github.com/ccf/agentcairn) closes with a rebuildable DuckDB index doing hybrid
retrieval — ported here, scaled to one personal vault, as a standalone CLI.

Markdown stays the source of truth; the index is a **rebuildable cache**. Delete
`.vault-index/vault.duckdb` (under the vault root) and rebuild from the markdown
at any time.

## How it works

```
build:  md files → chunk by heading → embed changed chunks (local model)
        → DuckDB (chunks + FTS index)
query:  text → cosine top-k + BM25 top-k → Reciprocal Rank Fusion
        → collapse per file → ranked results
```

- **Embeddings:** `bge-small-en-v1.5` (384-dim) via FastEmbed, **on-device**.
  No vault content leaves the machine. (Chosen over nomic-768 after measuring:
  chunks are short, so nomic's long context was wasted — bge-small builds ~5×
  faster with a ~half-size index. See the spec's Performance findings.)
- **Hybrid:** vectors for conceptual queries, BM25 for exact tokens (ticket IDs
  like `TICKET-1234`, service names, people, dates), fused with RRF.
- **Incremental:** unchanged pages (same content hash) are not re-embedded.

## Setup

```sh
cd vault-index
uv sync
uv run python scripts/prefetch.py    # one-time: download model + fts extension
```

`prefetch.py` is the **only** step that needs network — it downloads the
embedding model and the DuckDB `fts` extension into a pinned cache
(`~/.cache/vault-index/models` + `~/.duckdb/extensions`). Those hosts aren't on
the Claude Code sandbox network allowlist, so run prefetch with the sandbox
disabled (`/sandbox`, or a normal shell).

After that, `build`/`query` set `HF_HUB_OFFLINE=1` and read only the local cache —
they run **fully offline**, including inside the sandbox. (Override with
`HF_HUB_OFFLINE=0` to allow an online download.)

## Usage

```sh
uv run vault-index build            # build / incrementally update
uv run vault-index build --full     # rebuild from scratch
uv run vault-index query "how did we handle the settlement retry race" -k 5
uv run vault-index query "TICKET-1234" --json
uv run vault-index status
```

Override the vault root with `--root PATH` or `VAULT_INDEX_ROOT`.

## Staying fresh

You don't run `build` by hand. An incremental `vault-index build` step is wired
into the wiki commands so the index tracks content automatically:

the ingest and maintenance commands each run an incremental build step.

Incremental builds re-embed only changed chunks (~0s when nothing changed, a few
seconds otherwise). Run `--full` only after changing the model or chunking logic.

## Docker / cron

For scheduled builds that run in the claude-sandbox image, bake the caches into
the image so cron never touches the network — see
[`docker/prefetch.Dockerfile.snippet`](docker/prefetch.Dockerfile.snippet).

## Tests

```sh
uv run pytest
```

Unit tests (chunker, RRF) run offline. The build/query integration tests use a
deterministic fake embedder (no model download) and skip automatically if the
DuckDB `fts` extension isn't cached and there's no network.

## Compliance note

The `.duckdb` index is a second at-rest copy of vault text. It's gitignored and
must stay out of any sync/backup the markdown isn't part of. No new egress
(embeddings are local). Inherits the vault's data-handling posture.

## Deferred (YAGNI)

MCP server · `/vault-search` slash command · cross-encoder reranking · temporal
supersession tracking · HNSW approximate index (brute-force cosine scan is
instant at vault scale).
