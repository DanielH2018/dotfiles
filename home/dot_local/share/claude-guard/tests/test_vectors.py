"""The shared adversarial corpus, and byte-for-byte parity with the bash segmenter.

tests/fixtures/command-vectors.json at the repo root is asserted by two implementations
today: cmdparse.sh (bash) and auto-approve-readonly.py in the server repo. This package
replaces the first; until slice 6 retires the bash, both must agree, and this file is
where a divergence shows up.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from claude_guard.segment import parse, visible

REPO = Path(__file__).resolve().parents[5]
FIXTURE = REPO / "tests" / "fixtures" / "command-vectors.json"
CMDPARSE = REPO / "home" / "private_dot_claude" / "hooks" / "executable_cmdparse.sh"

skip_no_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason="corpus not beside a deployed copy"
)
skip_no_bash = pytest.mark.skipif(
    not (CMDPARSE.exists() and shutil.which("bash") and shutil.which("awk")),
    reason="bash segmenter unavailable",
)


def vectors() -> list[dict]:
    return json.loads(FIXTURE.read_text())["vectors"]


def bash_parse(command: str) -> dict:
    out = subprocess.run(
        ["bash", str(CMDPARSE), "--json"], input=command, capture_output=True, text=True, check=True
    ).stdout
    return json.loads(out)


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


# The bash side's heredoc field is lossy for empty heredoc bodies: the awk pass's \x1f join
# absorbs a leading empty body, and `read -d` drops a trailing one, while the port keeps both.
# Both parity tests below compare the heredoc field with empty bodies dropped from each side;
# seg, sep and subseg are still compared exactly.
# A command containing \x1f (the bash --json record separator) cannot be represented by the
# bash side, so the parity tests cannot see it either.
@skip_no_fixture
@skip_no_bash
@pytest.mark.parametrize("v", vectors() if FIXTURE.exists() else [], ids=lambda v: v["name"])
def test_bash_parity_on_the_corpus(v):
    b = bash_parse(v["command"])
    p = parse(v["command"])
    assert p.status == b["status"]
    assert [s.text for s in p.segments] == b["seg"]
    assert [s.sep for s in p.segments] == b["sep"]
    assert [[h for h in s.heredocs if h] for s in p.segments] == [
        [h for h in x.split("\x1f") if h] for x in b["heredoc"]
    ]
    assert list(p.substitutions) == b["subseg"]


@skip_no_bash
@pytest.mark.parametrize(
    "command",
    [
        "cat <<'EOF'\nline one\nEOF\nls",
        "git commit -am \"$(cat <<'EOF'\nbody\nEOF\n)\"",
        "echo $(echo $(id)) `whoami` ${x:-$(id)} $((1<<2))",
        "ls &&\n",
        "cmd 2>&1 >&2 | tail -3",
        "echo 'unbalanced",
        "cat <<A <<B\nA\nx\nB",
    ],
)
def test_bash_parity_on_hand_picked_shapes(command):
    b = bash_parse(command)
    p = parse(command)
    assert p.status == b["status"]
    assert [s.text for s in p.segments] == b["seg"]
    assert [s.sep for s in p.segments] == b["sep"]
    assert [[h for h in s.heredocs if h] for s in p.segments] == [
        [h for h in x.split("\x1f") if h] for x in b["heredoc"]
    ]
    assert list(p.substitutions) == b["subseg"]
