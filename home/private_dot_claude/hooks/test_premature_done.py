#!/usr/bin/env python3
"""Standalone tests for premature-done.py.

Run: python3 test_premature_done.py

Every rule gets a pair - one input it must flag and one it must leave alone - because a
guard that fires on everything and a guard that fires on nothing are indistinguishable
from the passing side alone. The silent half is the one that matters most here: this
hook runs at the end of every background-job turn, so a false positive costs the
session an extra round trip and teaches it to distrust the block.

The two flagged fixtures are verbatim tails from this machine's
~/.claude/jobs/*/timeline.jsonl on 2026-09-02 - two of the three sessions that
prompted the hook.
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
HOOK = HERE / "executable_premature-done.py"
if not HOOK.exists():  # deployed copy drops chezmoi's mode prefix
    HOOK = HERE / "premature-done.py"

spec = importlib.util.spec_from_file_location("premature_done", HOOK)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

failures: list[str] = []


def check(name: str, condition: bool) -> None:
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


# ---------------------------------------------------------------- classifies_done

KAGI = (
    "Then verify the change itself, not just the pod: load the dashboard in the "
    "`homelab-ui` browser and submit a query, confirming it lands on `kagi.com`.\n\n"
    "result: Homepage's search box switched from Google to Kagi (PR #824, merged); "
    "deploy blocked behind another session's broad `initial_setup.yml` change in "
    "PR #823."
)

RENOVATE = (
    "That's why the digest is keyed on a `gh pr list` delta rather than the session's "
    "exit status.\n\n"
    "result: Built PR #823 - a daily systemd timer running the `/renovate-prs` skill "
    "unattended on daniel-box, shipping disarmed; left unmerged because it touches "
    "`initial_setup.yml`, a broad-manual path."
)

AUDIT = (
    "The suggested `[tool.ruff.lint]` block is in the artifact.\n\n"
    "result: Tooling audit found two inert guards (156 dead noqa comments, a Vale "
    "rule below the alert threshold), no type checker, and 30 naive-datetime sites; "
    "report written to the artifacts directory."
)

check("result line alone is classified done", mod.classifies_done(KAGI) is not None)
check(
    "no result line is not classified done",
    mod.classifies_done("The deploy is blocked behind PR #823.") is None,
)
check(
    "result followed by next is not classified done",
    mod.classifies_done(KAGI + "\n\nnext: deploy once #823 lands.") is None,
)
check(
    "result followed by a blocked marker is not classified done",
    mod.classifies_done(KAGI + "\n\nblocked: #823 has to land first.") is None,
)
check(
    "result followed by a failed marker is not classified done",
    mod.classifies_done(KAGI + "\n\nfailed: the rollout never came up.") is None,
)
check(
    "result followed by a needs-input marker is not classified done",
    mod.classifies_done(KAGI + "\n\nneeds input: approve the cap raise.") is None,
)
check(
    "a result line inside a fence is not classified done",
    mod.classifies_done("Here is the shape:\n\n```\nresult: something\n```\n") is None,
)
check(
    "a later result line without next outranks an earlier one with next",
    mod.classifies_done("result: first pass done.\n\nnext: keep going.\n\n" + KAGI)
    is not None,
)
check(
    "a next line after the LAST result silences an earlier bare result",
    mod.classifies_done(
        "result: first pass done.\n\n" + KAGI + "\n\nnext: deploy once #823 lands."
    )
    is None,
)

# ------------------------------------------------------------------ contradiction

check("kagi tail is flagged", mod.contradiction(KAGI) == "deploy-blocked")
check("renovate tail is flagged", mod.contradiction(RENOVATE) == "left-undone")
check("audit tail is clean", mod.contradiction(AUDIT) is None)

PAIRS = [
    ("deploy-blocked", "the deploy is blocked on #823", "the deploy is green"),
    ("blocked-behind", "blocked behind another session", "unblocked at last"),
    ("left-undone", "left unmerged for now", "merged and applied cleanly"),
    ("not-yet", "not yet deployed to the cluster", "deployed to the cluster"),
    ("waiting-on", "waiting on CI to finish", "CI finished green"),
    ("pending", "pending deploy on daniel-box", "the deploy ran on daniel-box"),
    ("unfinished-adjective", "the change is undeployed", "the change is live"),
]
for rule, flagged, clean in PAIRS:
    check(f"{rule} flags its example", mod.contradiction(flagged) is not None)
    check(f"{rule} leaves its counterpart alone", mod.contradiction(clean) is None)


# ---------------------------------------------------------------------- turn_text


def write_transcript(path: Path, records: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
    )


def assistant(text: str, sidechain: bool = False) -> dict:
    return {
        "isSidechain": sidechain,
        "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
    }


def tool_result() -> dict:
    return {
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "content": "ok"}],
        }
    }


def user(text: str) -> dict:
    return {"message": {"role": "user", "content": [{"type": "text", "text": text}]}}


with tempfile.TemporaryDirectory(prefix="premature-done-") as tmp:
    tmpdir = Path(tmp)
    transcript = tmpdir / "session.jsonl"

    write_transcript(
        transcript,
        [
            user("do the first thing"),
            assistant("first turn answer"),
            user("do the second thing"),
            assistant("opening line"),
            tool_result(),
            assistant("closing line"),
        ],
    )
    text = mod.turn_text(transcript)
    check(
        "turn_text keeps both halves of the turn",
        text == "opening line\n\nclosing line",
    )
    check(
        "turn_text stops at the previous user message", "first turn answer" not in text
    )

    write_transcript(
        transcript,
        [
            user("go"),
            assistant("subagent chatter", sidechain=True),
            assistant("real answer"),
        ],
    )
    check(
        "turn_text skips sidechain records", mod.turn_text(transcript) == "real answer"
    )


# ------------------------------------------------------------------- end to end


def run(tail_records: list[dict], job_dir: Path | None, **env) -> dict | None:
    """Run the hook as a subprocess; its decision, or None when it stayed quiet."""
    with tempfile.TemporaryDirectory(prefix="premature-done-e2e-") as tmp:
        transcript = Path(tmp) / "session.jsonl"
        write_transcript(transcript, tail_records)
        environ = dict(os.environ)
        environ.pop("CLAUDE_PREMATURE_DONE_CHECK", None)
        if job_dir is None:
            environ.pop("CLAUDE_JOB_DIR", None)
        else:
            environ["CLAUDE_JOB_DIR"] = str(job_dir)
        stop_hook_active = env.pop("_stop_hook_active", False)
        environ.update(env)
        payload = {
            "session_id": "test",
            "transcript_path": str(transcript),
            "stop_hook_active": stop_hook_active,
        }
        result = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=environ,
            check=False,
        )
        out = result.stdout.strip()
        return json.loads(out) if out else None


with tempfile.TemporaryDirectory(prefix="premature-done-job-") as job:
    job_dir = Path(job)

    decision = run([user("go"), assistant(KAGI)], job_dir)
    check("a contradicted result blocks", (decision or {}).get("decision") == "block")
    check(
        "the block names the phrase it saw",
        "deploy-blocked" in (decision or {}).get("reason", ""),
    )
    check(
        "the block asks for a restated result and next",
        "next: <what still has to happen" in (decision or {}).get("reason", ""),
    )

    check(
        "the same ending does not block twice",
        run([user("go"), assistant(KAGI)], job_dir) is None,
    )
    check(
        "a different bad ending still blocks",
        (run([user("go"), assistant(RENOVATE)], job_dir) or {}).get("decision")
        == "block",
    )

with tempfile.TemporaryDirectory(prefix="premature-done-job-") as job:
    job_dir = Path(job)
    check(
        "an uncontradicted result stays quiet",
        run([user("go"), assistant(AUDIT)], job_dir) is None,
    )
    check(
        "a result with a next line stays quiet",
        run(
            [user("go"), assistant(KAGI + "\n\nnext: deploy once #823 lands.")], job_dir
        )
        is None,
    )
    check(
        "stop_hook_active stays quiet",
        run([user("go"), assistant(KAGI)], job_dir, _stop_hook_active=True) is None,
    )
    check(
        "a foreground session stays quiet",
        run([user("go"), assistant(KAGI)], None) is None,
    )
    check(
        "the opt-out stays quiet",
        run([user("go"), assistant(KAGI)], job_dir, CLAUDE_PREMATURE_DONE_CHECK="0")
        is None,
    )

print()
if failures:
    print(f"{len(failures)} failing: " + ", ".join(failures))
    sys.exit(1)
print("all green")
