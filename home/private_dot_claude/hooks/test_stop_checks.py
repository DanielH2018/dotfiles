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
        # Compact separators, as Claude Code writes them: the hook's session scan
        # prefilters lines on the literal byte string `"type":"create"`.
        lines = (json.dumps(r, separators=(",", ":")) + "\n" for r in records)
        transcript.write_text("".join(lines))
        payload = {"transcript_path": str(transcript), "last_assistant_message": reply}
        return mod.evaluate(payload, dict(env or ENV))


def tagged(reason: str | None, name: str) -> bool:
    return reason is not None and f"[stop-checks:{name}]" in reason


def tool(name: str, **data) -> dict:
    block = {"type": "tool_use", "id": "t", "name": name, "input": data}
    return {"message": {"role": "assistant", "content": [block]}}


def created(path: str) -> list[dict]:
    """A Write that created `path`: the call, and the result record naming it new."""
    result = {
        "message": {"role": "user", "content": [{"type": "tool_result"}]},
        "toolUseResult": {"type": "create", "filePath": path},
    }
    return [tool("Write", file_path=path, content="x"), result]


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


# ---------------------------------------------------------------- preamble

check(
    "a reply opening on a stock preamble blocks",
    tagged(evaluate("Great question! The cache was stale."), "preamble"),
)
check(
    "'You're absolutely right' as an opener blocks",
    tagged(evaluate("You're absolutely right, the path was wrong."), "preamble"),
)
check(
    "a reply that leads with the outcome passes",
    not tagged(evaluate("The cache was stale; the fix is in #12."), "preamble"),
)
check(
    "a first word that only starts like an opener passes",
    not tagged(evaluate("Sure-footed parsing needs a lexer."), "preamble"),
)

# ---------------------------------------------------------------- evidence-for-claims

CLAIM = "Fixed the retry. All tests pass."
check(
    "a tests-pass claim with no test run in the session blocks",
    tagged(
        evaluate(CLAIM, [user("fix it"), tool("Bash", command="ls")]),
        "evidence-for-claims",
    ),
)
check(
    "a tests-pass claim after a pytest run passes",
    not tagged(
        evaluate(CLAIM, [user("fix it"), tool("Bash", command="uv run pytest -q")]),
        "evidence-for-claims",
    ),
)
check(
    "a lint claim with only a test run blocks",
    tagged(
        evaluate(
            "The linter is clean.", [user("x"), tool("Bash", command="node --test")]
        ),
        "evidence-for-claims",
    ),
)
check(
    "a claim the reply marks unverified passes",
    not tagged(
        evaluate("Tests pass locally is unverified: I did not run them.", [user("x")]),
        "evidence-for-claims",
    ),
)

# ---------------------------------------------------------------- tests-for-source

SRC = "/work/repo/src/ledger.py"
check(
    "a new source file with no test file touched blocks",
    tagged(evaluate("Done.", [user("x"), *created(SRC)]), "tests-for-source"),
)
check(
    "a new source file plus an edited test file passes",
    not tagged(
        evaluate(
            "Done.",
            [
                user("x"),
                *created(SRC),
                tool("Edit", file_path="/work/repo/tests/test_ledger.py"),
            ],
        ),
        "tests-for-source",
    ),
)
check(
    "editing an existing source file (no create) passes",
    not tagged(
        evaluate("Done.", [user("x"), tool("Edit", file_path=SRC)]), "tests-for-source"
    ),
)
check(
    "a scratch file under /tmp passes",
    not tagged(
        evaluate("Done.", [user("x"), *created("/tmp/probe.py")]), "tests-for-source"
    ),
)
check(
    "the session check stays quiet once it has fired anywhere in the session",
    not tagged(
        evaluate(
            "Done.",
            [
                user("x"),
                *created(SRC),
                feedback("[stop-checks:tests-for-source] x"),
                user("next thing"),
            ],
        ),
        "tests-for-source",
    ),
)

# ---------------------------------------------------------------- migration

with tempfile.TemporaryDirectory(prefix="stop-checks-mig-") as mig_tmp:
    mig = Path(mig_tmp) / "migrations"
    mig.mkdir()
    one_way = mig / "0002_drop_col.sql"
    one_way.write_text("ALTER TABLE orders DROP COLUMN legacy;\n")
    both = mig / "0003_add_col.sql"
    both.write_text("-- up\nALTER TABLE t ADD c int;\n-- down\nALTER TABLE t DROP c;\n")
    up_only = mig / "0004_idx.up.sql"
    up_only.write_text("CREATE INDEX i ON t(c);\n")
    reviewed = tool("Agent", subagent_type="migration-reviewer", prompt="review")

    check(
        "a migration with no down step blocks",
        tagged(
            evaluate(
                "Done.", [user("x"), tool("Write", file_path=str(one_way)), reviewed]
            ),
            "migration",
        ),
    )
    check(
        "a reversible, reviewed migration passes",
        not tagged(
            evaluate(
                "Done.", [user("x"), tool("Write", file_path=str(both)), reviewed]
            ),
            "migration",
        ),
    )
    check(
        "an unreviewed reversible migration blocks",
        tagged(
            evaluate("Done.", [user("x"), tool("Write", file_path=str(both))]),
            "migration",
        ),
    )
    check(
        "an .up.sql without its .down.sql sibling blocks",
        tagged(
            evaluate(
                "Done.", [user("x"), tool("Write", file_path=str(up_only)), reviewed]
            ),
            "migration",
        ),
    )
    (mig / "0004_idx.down.sql").write_text("DROP INDEX i;\n")
    check(
        "an .up.sql with its .down.sql sibling passes",
        not tagged(
            evaluate(
                "Done.", [user("x"), tool("Write", file_path=str(up_only)), reviewed]
            ),
            "migration",
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
