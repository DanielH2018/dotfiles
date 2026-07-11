"""FastEmbed wrapper — local, on-device embeddings with nomic task prefixes."""

from __future__ import annotations

from pathlib import Path

from .config import DOC_PREFIX, MODEL_CACHE_DIR, MODEL_NAME, QUERY_PREFIX


class Embedder:
    def __init__(self, model_name: str = MODEL_NAME, cache_dir: Path | None = None) -> None:
        self.model_name = model_name
        self.cache_dir = Path(cache_dir or MODEL_CACHE_DIR)
        self._model = None  # lazy: defer the model download until first use

    def _load(self):
        if self._model is None:
            try:
                from fastembed import TextEmbedding
            except ImportError as e:  # pragma: no cover
                raise RuntimeError(
                    "fastembed not installed — run `uv sync` in vault-index/"
                ) from e
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            try:
                self._model = TextEmbedding(
                    model_name=self.model_name, cache_dir=str(self.cache_dir)
                )
            except Exception as e:
                raise RuntimeError(
                    f"Failed to load embedding model {self.model_name!r}. "
                    "First use downloads it from Hugging Face; that host is not on the "
                    "sandbox network allowlist, so the initial fetch needs sandbox "
                    "network disabled (or pre-cache via scripts/prefetch.py). After it "
                    "caches, runs work offline.\n"
                    f"Cause: {e}"
                ) from e
        return self._model

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        model = self._load()
        prefixed = [DOC_PREFIX + t for t in texts]
        return [vec.tolist() for vec in model.embed(prefixed)]

    def embed_query(self, text: str) -> list[float]:
        model = self._load()
        vec = next(iter(model.embed([QUERY_PREFIX + text])))
        return vec.tolist()
