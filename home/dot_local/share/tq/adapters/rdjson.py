"""reviewdog's rdjson -> Result, so tq can digest a linter it has never met.

rdjson is the one diagnostic format that is both flat enough to read cheaply
and rich enough to be worth reading: a message, a path, a range, a severity, a
rule code with its documentation, and suggested edits. Tools emit it natively
(biome, ruff), and anything that does not can be converted by reviewdog's own
errorformat, which makes this the widest ingest tq has for the least code.

Per-diagnostic fields are all optional in the format, and a run may declare a
severity and a source once at the top level for every finding beneath it.
"""

from __future__ import annotations

import json

from result import Failure

# rdjson shouts its severities; tq stores LSP's lowercase names.
SEVERITY = {
    "ERROR": "error",
    "WARNING": "warning",
    "INFO": "info",
    "UNKNOWN_SEVERITY": "error",
}


def _position(where):
    point = (where or {}).get("start") or {}
    end = (where or {}).get("end") or {}
    return (
        point.get("line"),
        point.get("column"),
        end.get("line"),
        end.get("column"),
    )


def parse(stdout, result):
    """Fill `result` in place. Returns it for convenience."""
    try:
        payload = json.loads(stdout or "")
    except ValueError:
        return result  # not JSON: leave it to the caller's raw-output fallback
    if not isinstance(payload, dict):
        return result
    diagnostics = payload.get("diagnostics")
    if diagnostics is None:
        return result

    source = ((payload.get("source") or {}).get("name")) or None
    fallback = SEVERITY.get(payload.get("severity") or "", "error")
    for note in diagnostics:
        location = note.get("location") or {}
        line, column, end_line, end_column = _position(location.get("range"))
        code = note.get("code") or {}
        result.failures.append(
            Failure(
                name=code.get("value") or source or "rdjson",
                file=location.get("path"),
                line=line,
                column=column,
                end_line=end_line,
                end_column=end_column,
                severity=SEVERITY.get(note.get("severity") or "", fallback),
                code_url=code.get("url"),
                source=source,
                # rdjson states the edit but never whether applying it is safe,
                # so tq must not claim it is.
                fixable="unsafe" if note.get("suggestions") else None,
                message=(note.get("message") or "").strip(),
            )
        )
    return result
