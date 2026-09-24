#!/usr/bin/env python3
"""Standalone tests for stop-checks.py.

Run: python3 test_stop_checks.py

Every check gets a pair: a reply it must block and a reply it must leave alone. A guard
that fires on everything and a guard that fires on nothing look the same from the
passing side alone. The once-rule gets its own pair, because it is what keeps a false
positive down to one extra turn.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _testkit import check, finish  # noqa: E402

HOOK = HERE / "executable_stop-checks.py"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "stop-checks.py"

spec = importlib.util.spec_from_file_location("stop_checks", HOOK)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

LINK = "http://127.0.0.1:8181/plan_2026-09-24.html"
ENV = {"CLAUDE_ARTIFACTS_PORT": "8181"}


def user(text: str) -> dict:
    return {"message": {"role": "user", "content": [{"type": "text", "text": text}]}}


def feedback(text: str) -> dict:
    return {"message": {"role": "user", "content": "Stop hook feedback:\n" + text}}


def assistant(text: str) -> dict:
    return {
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}
    }


def evaluate(reply: str, records=(), env=None) -> str | None:
    """The hook's decision for `reply` over a transcript of `records`."""
    with tempfile.TemporaryDirectory(prefix="stop-checks-") as tmp:
        transcript = Path(tmp) / "session.jsonl"
        transcript.write_text("".join(json.dumps(r) + "\n" for r in records))
        payload = {"transcript_path": str(transcript), "last_assistant_message": reply}
        return mod.evaluate(payload, dict(env or ENV))


def tagged(reason: str | None, name: str) -> bool:
    return reason is not None and f"[stop-checks:{name}]" in reason


# ---------------------------------------------------------------- artifact-link-last

check(
    "a reply that ends on the artifact link passes",
    not tagged(evaluate(f"Plan written.\n\n{LINK}\n"), "artifact-link-last"),
)
check(
    "a reply with text after the artifact link blocks",
    tagged(
        evaluate(f"Plan written.\n\n{LINK}\n\n**Takeaway** the loop was O(n^2)."),
        "artifact-link-last",
    ),
)
check(
    "a markdown-wrapped link on the last line passes",
    not tagged(evaluate(f"Done.\n\n[plan]({LINK})"), "artifact-link-last"),
)
check(
    "a file:// artifacts link followed by text blocks",
    tagged(
        evaluate("See file:///home/u/.claude/artifacts/x.html for it.\nMore text."),
        "artifact-link-last",
    ),
)
check(
    "the cluster route under CLAUDE_ARTIFACTS_BASE_URL is recognised",
    tagged(
        evaluate(
            "https://artifacts.example.com/a/box/x.html\nthen prose",
            env={**ENV, "CLAUDE_ARTIFACTS_BASE_URL": "https://artifacts.example.com"},
        ),
        "artifact-link-last",
    ),
)
check(
    "a link quoted inside a code fence does not count",
    not tagged(
        evaluate(f"The hook prints:\n```\n{LINK}\n```\nThat is all."),
        "artifact-link-last",
    ),
)
check(
    "a loopback URL on another port is not an artifact link",
    not tagged(
        evaluate("Dev server at http://127.0.0.1:3000/ now.\nDone."),
        "artifact-link-last",
    ),
)

# ---------------------------------------------------------------- once per turn

BAD = f"{LINK}\ntrailing prose"
check(
    "a turn already blocked by this check stays quiet",
    evaluate(
        BAD,
        [
            user("write the plan"),
            assistant(BAD),
            feedback("[stop-checks:artifact-link-last] x"),
        ],
    )
    is None,
)
check(
    "a block from an earlier turn does not silence this one",
    tagged(
        evaluate(
            BAD,
            [
                user("write the plan"),
                feedback("[stop-checks:artifact-link-last] x"),
                user("now the second plan"),
                assistant(BAD),
            ],
        ),
        "artifact-link-last",
    ),
)
check(
    "another hook's feedback this turn does not silence this check",
    tagged(
        evaluate(
            BAD, [user("go"), assistant(BAD), feedback("A rebase is in progress.")]
        ),
        "artifact-link-last",
    ),
)


# ---------------------------------------------------------------- the process


def run_hook(payload: dict, **env) -> dict | None:
    environ = dict(os.environ)
    environ.pop("CLAUDE_STOP_CHECKS", None)
    environ.update(ENV)
    environ.update(env)
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=environ,
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    return json.loads(proc.stdout)


decision = run_hook({"last_assistant_message": BAD})
check(
    "the hook process prints a block decision",
    bool(decision) and decision.get("decision") == "block",
)
check(
    "CLAUDE_STOP_CHECKS=0 silences the hook",
    run_hook({"last_assistant_message": BAD}, CLAUDE_STOP_CHECKS="0") is None,
)
check("unparseable stdin is silent", run_hook("not json") is None)  # type: ignore[arg-type]

finish()
