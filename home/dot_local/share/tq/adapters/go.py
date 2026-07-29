"""go test -json NDJSON (test2json) -> Result.

`go test -json ./...` streams one JSON object per line, documented by
`go doc test2json`: {"Time","Action","Package","Test","Output","Elapsed"}.
"Action" is "run" (a test started, not needed here), "output" (captured text,
tied to a Package and optionally a Test), or "pass"/"fail"/"skip" (an
outcome). The outcome events matter most: one with a "Test" field is that
test's own result; one without is the package's overall result restating a
test already counted, and must not be added a second time.

Unlike node --test, go does not separate stdout from stderr in this stream —
everything a failing test printed, including a subprocess it shelled out to,
arrives as "output" events in Time order. There is also no separate reporter
file to read: go test writes NDJSON straight to its own stdout, which the
caller already has captured as a string.
"""

from __future__ import annotations

import json
import re

from result import Failure

# `    sub_test.go:10: expected 2, got 3`, the way t.Errorf/t.Fatalf print it —
# indented, and naming the bare file go's own test binary was compiled from
# rather than a full path.
LOCATION = re.compile(r"(?P<file>[\w./-]+\.go):(?P<line>\d+):\s*(?P<message>.*)")


def _locate(text):
    """`file, line, message` pulled out of a failing test's captured output,
    or the whole thing as the message when no `file.go:line:` line is in it."""
    for line in text.splitlines():
        match = LOCATION.search(line)
        if match:
            return (
                match.group("file"),
                int(match.group("line")),
                match.group("message").strip(),
            )
    return None, None, text.strip()


def parse_go_test(stdout, result):
    """Fill `result` in place. Returns it for convenience."""
    output = {}
    counts = {"pass": 0, "fail": 0, "skip": 0}
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue  # a partial final line, from a killed run, beats losing it all
        test = rec.get("Test")
        if test is None:
            continue  # package-level output or outcome, not an individual test
        action = rec.get("Action")
        key = (rec.get("Package"), test)
        if action == "output":
            output.setdefault(key, []).append(rec.get("Output") or "")
        elif action in counts:
            counts[action] += 1
            if action == "fail":
                text = "".join(output.get(key, []))
                file, line_no, message = _locate(text)
                result.failures.append(
                    Failure(
                        name=test, file=file, line=line_no, message=message, stdout=text
                    )
                )

    result.totals.update(
        tests=sum(counts.values()),
        **{"pass": counts["pass"]},
        fail=counts["fail"],
        skip=counts["skip"],
    )
    return result
