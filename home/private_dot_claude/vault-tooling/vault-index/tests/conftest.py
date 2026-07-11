import hashlib
from pathlib import Path

import pytest

from vault_index.config import EMBED_DIM, Config

FIXTURE_ROOT = Path(__file__).parent / "fixture_vault"


class FakeEmbedder:
    """Deterministic hashed bag-of-words vectors — no model download, offline."""

    def __init__(self, dim: int = EMBED_DIM) -> None:
        self.dim = dim

    def _vec(self, text: str) -> list[float]:
        import re

        v = [0.0] * self.dim
        for tok in re.findall(r"\w+", text.lower()):
            idx = int(hashlib.md5(tok.encode()).hexdigest(), 16) % self.dim
            v[idx] += 1.0
        norm = sum(x * x for x in v) ** 0.5 or 1.0
        return [x / norm for x in v]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)


@pytest.fixture
def fixture_config(tmp_path) -> Config:
    return Config(root=FIXTURE_ROOT, index_path=tmp_path / "test.duckdb")


@pytest.fixture
def fake_embedder() -> FakeEmbedder:
    return FakeEmbedder()
