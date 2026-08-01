"""Configuration: defaults with env/CLI override."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


# Vault-agnostic default fallback, consistent with the CLAUDE_VAULT_DIR contract used
# by the rest of the vault tooling (config-map, the vault-bootstrap script): when
# neither --root nor $VAULT_INDEX_ROOT is given, fall back to $CLAUDE_VAULT_DIR, then
# to $HOME/Documents/My_Vault. This package no longer lives inside the vault (its
# canonical home is the dotfiles/chezmoi checkout), so it can't infer the vault root
# from its own install path — an env-based resolver is the only thing that works
# across every machine this deploys to, vault or no vault.
def _default_root() -> Path:
    env = os.environ.get("CLAUDE_VAULT_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "Documents" / "My_Vault"


# When include_dirs is None (the default), the whole root is walked, minus
# exclude_dirs/exclude_files — vault-agnostic, no assumption about folder naming.
# Pass an explicit include_dirs tuple (or use --paths-from / include_paths) to
# restrict indexing to specific named top-level folders.
DEFAULT_INCLUDE_DIRS: tuple[str, ...] | None = None

# Paths never indexed even if they contain markdown.
DEFAULT_EXCLUDE_DIRS = (
    "docs",
    "claude-audit-portable",
    "raw",
    "superpowers",
    ".vault-index",
    ".git",
    ".claude",
    "vault-index",
    ".obsidian",
    "node_modules",
)

# Root-level bookkeeping files that are not wiki content.
DEFAULT_EXCLUDE_FILES = ("index.md", "log.md", "CLAUDE.md")

MODEL_NAME = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384

# Pin the model cache to a stable absolute path. FastEmbed otherwise caches under
# $TMPDIR, which differs between sandboxed and non-sandboxed runs, so a model fetched
# by prefetch wouldn't be found at build/query time. Override with $VAULT_INDEX_MODEL_CACHE.
MODEL_CACHE_DIR = Path(
    os.environ.get("VAULT_INDEX_MODEL_CACHE", Path.home() / ".cache" / "vault-index" / "models")
)

# bge-v1.5 retrieval convention: instruct the query only; passages get no prefix.
DOC_PREFIX = ""
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

# Chunk cap in characters (~500 tokens). Kept small on purpose: FastEmbed pads
# each batch to its longest member, so a few long chunks make CPU embedding
# pathologically slow. Split sections that exceed this.
MAX_CHUNK_CHARS = 2000

# RRF constant.
RRF_K = 60


@dataclass
class Config:
    root: Path = field(default_factory=_default_root)
    include_dirs: tuple[str, ...] | None = DEFAULT_INCLUDE_DIRS
    exclude_dirs: tuple[str, ...] = DEFAULT_EXCLUDE_DIRS
    exclude_files: tuple[str, ...] = DEFAULT_EXCLUDE_FILES
    model_name: str = MODEL_NAME
    embed_dim: int = EMBED_DIM
    max_chunk_chars: int = MAX_CHUNK_CHARS
    index_path: Path = field(default=None)  # type: ignore[assignment]
    # When set, indexing is restricted to exactly these entries (files or dirs,
    # relative to root) instead of walking include_dirs. Enforces the sandbox
    # curation boundary: index only the allowlisted vault subset.
    include_paths: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()
        if self.index_path is None:
            # Hidden state dir at the vault root — decoupled from wherever the
            # vault-index *code* happens to be deployed (chezmoi, not the vault).
            self.index_path = self.root / ".vault-index" / "vault.duckdb"
        self.index_path = Path(self.index_path)

    @classmethod
    def load(cls, root: str | os.PathLike | None = None) -> Config:
        if root:
            resolved = Path(root).resolve()
        else:
            env_root = os.environ.get("VAULT_INDEX_ROOT")
            resolved = Path(env_root).resolve() if env_root else _default_root().resolve()
        return cls(root=resolved)
