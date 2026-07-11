"""CLI: build / query / status."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Use the local model cache only — never reach Hugging Face at build/query time.
# FastEmbed otherwise pings HF on load even when the model is cached, which fails
# offline / in the sandbox. Warm the cache once with scripts/prefetch.py.
# Override with HF_HUB_OFFLINE=0 to allow an online download.
os.environ.setdefault("HF_HUB_OFFLINE", "1")

from .config import Config
from .indexer import build as build_index
from .indexer import status as index_status
from .query import search


def _parse_paths_file(path: str) -> list[str]:
    """Parse an allowlist file: one path per line, `#` comments, blanks ignored.
    Never indexes CLAUDE.md / index.md even if listed."""
    entries = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or os.path.basename(line) in ("CLAUDE.md", "index.md"):
            continue
        entries.append(line)
    return entries


def _cmd_build(args: argparse.Namespace) -> int:
    config = Config.load(args.root)
    if not config.root.is_dir():
        # Vault-optional: never materialize a phantom vault / empty index on a
        # machine that has no vault (or CLAUDE_VAULT_DIR unset). Mirrors config-map.
        print(f"no vault at {config.root} — skipping index build")
        return 0
    if args.db:
        config.index_path = Path(args.db)
    if args.paths_from:
        config.include_paths = tuple(_parse_paths_file(args.paths_from))
    stats = build_index(config, full=args.full)
    print(
        f"indexed {stats.files} files / {stats.total_chunks} chunks — "
        f"embedded {stats.embedded}, skipped {stats.skipped}, deleted {stats.deleted}"
    )
    print(f"index: {config.index_path}")
    return 0


def _cmd_query(args: argparse.Namespace) -> int:
    config = Config.load(args.root)
    if args.db:
        config.index_path = Path(args.db)
    if not config.index_path.exists():
        # Clean message (matching `status`) instead of an uncaught duckdb.IOException
        # when querying before the first build.
        print(f"no index at {config.index_path} — run `vault-index build`")
        return 0
    results = search(config, args.text, k=args.k)
    if args.json:
        print(json.dumps([r.__dict__ for r in results], indent=2))
        return 0
    if not results:
        print("no matches")
        return 0
    for i, r in enumerate(results, 1):
        loc = f"{r.path}" + (f" › {r.heading}" if r.heading else "")
        print(f"{i}. [{r.score:.4f}] {loc}")
        print(f"   {r.snippet}")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    config = Config.load(args.root)
    st = index_status(config)
    if not st["exists"]:
        print(f"no index at {st['index_path']} — run `vault-index build`")
        return 0
    print(f"index:      {st['index_path']}")
    print(f"chunks:     {st['chunks']}")
    print(f"files:      {st['files']}")
    print(f"model:      {st['model']}")
    print(f"last build: {st['last_build']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vault-index", description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", help="vault root (default: auto / $VAULT_INDEX_ROOT)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", parents=[common], help="build/update the index")
    p_build.add_argument("--full", action="store_true", help="rebuild from scratch")
    p_build.add_argument("--db", help="index file path (default: <root>/vault-index/.index/vault.duckdb)")
    p_build.add_argument("--paths-from", help="restrict indexing to the entries in this allowlist file")
    p_build.set_defaults(func=_cmd_build)

    p_query = sub.add_parser("query", parents=[common], help="hybrid search")
    p_query.add_argument("text")
    p_query.add_argument("-k", type=int, default=8, help="number of results")
    p_query.add_argument("--db", help="index file path to query")
    p_query.add_argument("--json", action="store_true")
    p_query.set_defaults(func=_cmd_query)

    p_status = sub.add_parser("status", parents=[common], help="index stats")
    p_status.set_defaults(func=_cmd_status)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
