#!/usr/bin/env python3
"""Standalone tests for bin/skill-usage.

Run: python3 test_skill_usage_table.py

skill-usage-log.sh (tested in test_skill_usage_log.py) writes the fire log; this is
the read side, and the one property that matters for the scaffolding-delete-pass this
was built for is the one this test pins: an installed skill/agent/plugin with NO
matching log entry must still appear in the table, at count 0, with "never" as its
last-fired date -- and sorted below everything that has fired at least once. A table
that only lists what already fired would be useless for finding what to delete.

Also pins the two ways this table could read as "everything is zero-fire" without
actually being that -- a log entry whose name doesn't match anything currently
installed, and a corrupt/truncated log line -- neither of which the count-only checks
above would catch: a join that silently drops what it can't match, or a parser that
collapses the whole log to empty, both produce exactly the same all-zero table as a
genuinely unused skill.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
# hooks/ -> private_dot_claude/ -> home/ -> repo root
BIN = HERE.parent.parent.parent / "bin" / "skill-usage"


def run(env_extra):
    env = {**os.environ, **env_extra}
    result = subprocess.run(
        ["bash", str(BIN)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return result


failures = []


def check(name, condition):
    print(f"{'ok  ' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "repo"
    (root / "home" / "private_dot_claude" / "skills" / "fired-skill").mkdir(
        parents=True
    )
    (
        root / "home" / "private_dot_claude" / "skills" / "fired-skill" / "SKILL.md"
    ).write_text("---\n")
    (root / "home" / "private_dot_claude" / "skills" / "never-fired-skill").mkdir(
        parents=True
    )
    (
        root
        / "home"
        / "private_dot_claude"
        / "skills"
        / "never-fired-skill"
        / "SKILL.md"
    ).write_text("---\n")
    (root / "home" / "private_dot_claude" / "agents").mkdir(parents=True)
    (
        root / "home" / "private_dot_claude" / "agents" / "never-fired-agent.md"
    ).write_text("---\n")

    claude_dir = Path(tmp) / "claude"
    (claude_dir / "plugins").mkdir(parents=True)
    (claude_dir / "plugins" / "installed_plugins.json").write_text(
        json.dumps({"plugins": {"never-fired-plugin@market": [{"scope": "user"}]}})
    )
    (claude_dir / "settings.json").write_text(
        json.dumps({"enabledPlugins": {"never-fired-plugin@market": True}})
    )

    log = Path(tmp) / "skill-usage.jsonl"
    log.write_text(
        json.dumps(
            {
                "ts": "2026-09-01T00:00:00Z",
                "kind": "skill",
                "name": "fired-skill",
                "ok": True,
            }
        )
        + "\n"
        # A name that matches nothing installed (renamed/removed skill, or a naming-
        # convention mismatch) must be visible as unmatched, not silently absorbed into
        # the zero counts of whatever it doesn't match -- an unmatched log entry and a
        # genuinely-never-fired skill are different findings and must not read the same.
        + json.dumps(
            {
                "ts": "2026-09-01T00:00:00Z",
                "kind": "skill",
                "name": "renamed-away-skill",
                "ok": True,
            }
        )
        + "\n"
        # A truncated/corrupt append (a write cut off mid-line) must be skipped and
        # counted, not silently collapse the whole log to empty -- a parse failure and
        # a genuinely empty log are different findings and must not read the same.
        + '{"ts":"2026-09-01T00:00:00Z","kind":"skill","name":"fired-skil\n'
    )

    # Same day as the fixture entry -- keeps it inside the window without depending
    # on when this test happens to run.
    now_epoch = int(datetime(2026, 9, 1, tzinfo=timezone.utc).timestamp())
    result = run(
        {
            "SKILL_USAGE_ROOT": str(root),
            "SKILL_USAGE_LOG": str(log),
            "SKILL_USAGE_CLAUDE_DIR": str(claude_dir),
            "SKILL_USAGE_NOW_EPOCH": str(now_epoch),
        }
    )

    check("bin/skill-usage exits 0", result.returncode == 0)
    out = result.stdout

    check(
        "the fired skill appears with a nonzero count",
        "fired-skill" in out and "1" in out,
    )
    check("a never-fired skill still appears in the table", "never-fired-skill" in out)
    check("a never-fired agent still appears in the table", "never-fired-agent" in out)
    check(
        "a never-fired (but enabled) plugin still appears in the table",
        "never-fired-plugin" in out,
    )
    check("a never-fired entry is stamped 'never'", "never" in out)

    lines = [line for line in out.splitlines() if line.strip()]
    fired_idx = next(
        (
            i
            for i, line in enumerate(lines)
            if "fired-skill" in line and "never-fired" not in line
        ),
        None,
    )
    never_idx = next(
        (i for i, line in enumerate(lines) if "never-fired-skill" in line), None
    )
    check(
        "the zero-fire entry sorts below the entry that actually fired",
        fired_idx is not None and never_idx is not None and fired_idx < never_idx,
    )

    # ── the two red-proof cases: a naming mismatch and a corrupt line must be
    #    VISIBLE, not silently absorbed into an all-zero table (this is the exact
    #    failure mode a scaffolding-delete-pass consumer cannot afford: it reads as
    #    "delete everything installed"). ─────────────────────────────────────────

    check(
        "a log entry matching no installed name is surfaced as unmatched",
        "Unmatched" in out and "renamed-away-skill" in out,
    )
    check(
        "a corrupt/truncated log line is reported, not silently swallowed",
        "failed to parse" in out,
    )
    check(
        "the corrupt line does not corrupt the count for a well-formed entry",
        fired_idx is not None and lines[fired_idx].split()[2] == "1",
    )

print()
if failures:
    print(f"{len(failures)} failure(s): {', '.join(failures)}")
    raise SystemExit(1)
print("all passed")
