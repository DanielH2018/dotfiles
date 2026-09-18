"""The shared adversarial corpus.

tests/fixtures/command-vectors.json at the repo root is asserted by two implementations:
this package's segmenter (the `cmdparse` field, whose name is the bash segmenter it
replaced -- slice 6 deleted cmdparse.sh and the parity tests that ran it) and
auto-approve-readonly.py in the server repo. The corpus is what keeps the two from
diverging; this file is the package's half.
"""

import json
from pathlib import Path

import pytest

from claude_guard.segment import parse, visible

REPO = Path(__file__).resolve().parents[5]
FIXTURE = REPO / "tests" / "fixtures" / "command-vectors.json"

skip_no_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason="corpus not beside a deployed copy"
)


def vectors() -> list[dict]:
    return json.loads(FIXTURE.read_text())["vectors"]


@skip_no_fixture
def test_the_corpus_is_not_silently_empty():
    vs = vectors()
    assert len(vs) >= 10
    assert any(v["readonly"] for v in vs)
    assert any(not v["readonly"] for v in vs)


@skip_no_fixture
@pytest.mark.parametrize("v", vectors() if FIXTURE.exists() else [], ids=lambda v: v["name"])
def test_corpus_vector(v):
    p = parse(v["command"])
    assert p.status == v["cmdparse"]["status"]
    assert visible(p) == v["cmdparse"]["segments"]
