"""cargo test's default libtest text output -> Result.

No stable JSON exists for `cargo test` itself — the machine-readable
`--format=json` is nightly-only — so this reads the same lines a person
watching the terminal would. A workspace runs one libtest binary per crate,
back to back, so both the per-test lines and the "test result:" summaries can
repeat: totals are summed across every "test result:" line rather than taken
from the last one, and the per-binary state (which names just failed, which
"---- name stdout ----" blocks belong to them) resets at each one too, so a
block from the second binary can never be mistaken for a same-named test in
the first.
"""

from __future__ import annotations

import re

from result import Failure, strip_ansi

TEST_LINE = re.compile(r"^test (?P<name>\S+) \.\.\. (?P<status>ok|FAILED|ignored)\b")
RESULT_LINE = re.compile(
    r"^test result: \w+\. (?P<passed>\d+) passed; (?P<failed>\d+) failed; "
    r"(?P<ignored>\d+) ignored; \d+ measured; \d+ filtered out"
)
BLOCK_START = re.compile(r"^---- (?P<name>\S+) stdout ----$")
PANIC = re.compile(r"^thread '.*?' panicked at (?P<file>[^:]+):(?P<line>\d+):\d+:$")


def _panic_detail(body):
    """`(message, file, line)` dug out of a captured stdout block.

    libtest carries no separate "message" field the way JUnit does — the
    panic text after `thread '...' panicked at file:line:col:` *is* the
    failure detail. A block with no such line (a captured print with no
    panic in it, which should not happen but is not this adapter's to assume)
    falls back to reporting the block whole, with no location.
    """
    lines = body.splitlines()
    for idx, line in enumerate(lines):
        m = PANIC.match(line)
        if m:
            message = "\n".join(lines[idx + 1 :]).strip()
            return message or line, m.group("file"), int(m.group("line"))
    return body.strip(), None, None


def parse_cargo_test(stdout, result):
    """Fill `result` in place. Returns it for convenience."""
    lines = strip_ansi(stdout or "").splitlines()
    failed_order, captured = [], {}
    totals = {"tests": 0, "pass": 0, "fail": 0, "skip": 0}

    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        test_m = TEST_LINE.match(line)
        if test_m:
            if test_m.group("status") == "FAILED":
                failed_order.append(test_m.group("name"))
            i += 1
            continue
        block_m = BLOCK_START.match(line)
        if block_m:
            name = block_m.group("name")
            i += 1
            body = []
            while i < n and not BLOCK_START.match(lines[i]) and lines[i] != "failures:":
                body.append(lines[i])
                i += 1
            captured[name] = "\n".join(body).strip("\n")
            continue
        result_m = RESULT_LINE.match(line)
        if result_m:
            totals["pass"] += int(result_m.group("passed"))
            totals["fail"] += int(result_m.group("failed"))
            totals["skip"] += int(result_m.group("ignored"))
            for name in failed_order:
                body = captured.get(name, "")
                message, file, line_no = _panic_detail(body)
                result.failures.append(
                    Failure(
                        name=name, file=file, line=line_no, message=message, stdout=body
                    )
                )
            # Closes out this binary's names and blocks before the next
            # `running N tests` section can reuse either.
            failed_order, captured = [], {}
            i += 1
            continue
        i += 1

    totals["tests"] = totals["pass"] + totals["fail"] + totals["skip"]
    result.totals.update(totals)
    return result
