import hashlib
import shutil
from pathlib import Path

import duckdb
import pytest

from vault_index.config import EMBED_DIM, Config
from vault_index.indexer import build

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


@pytest.fixture(scope="session")
def _prebuilt_index(tmp_path_factory) -> Path:
    """A full build of the fixture vault, done once. It costs ~1.2s and was the whole suite's
    dominant cost when every test that merely *needed* an index paid for its own."""
    path = tmp_path_factory.mktemp("prebuilt") / "test.duckdb"
    try:
        build(
            Config(root=FIXTURE_ROOT, index_path=path),
            embedder=FakeEmbedder(),
            full=True,
        )
    except duckdb.Error as e:  # fts extension needs network on first use
        pytest.skip(f"duckdb fts extension unavailable offline: {e}")
    return path


@pytest.fixture
def built_config(tmp_path, _prebuilt_index) -> Config:
    """A config whose index is already built, as a private copy — tests may mutate it freely.
    Use this instead of building in the test unless the build itself is what's under test."""
    index_path = tmp_path / "test.duckdb"
    shutil.copyfile(_prebuilt_index, index_path)
    return Config(root=FIXTURE_ROOT, index_path=index_path)
