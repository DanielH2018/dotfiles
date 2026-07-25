"""Linter diagnostics -> Result, for tools that report findings rather than tests.

The shapes differ enough to matter: a test runner tells you how many things it
checked and how many held, so a digest can say 651/665. A linter only ever names
what is wrong. There is no denominator — silence about a line is not a passing
assertion about it — so these runs get counted, never scored.
"""

from __future__ import annotations

import json

from result import TOTAL_KEYS, Failure

# Worst first, so that when a run overflows the digest's failure cap it is the
# errors that survive and the style nits that get pushed into the json.
LEVEL_RANK = {"error": 0, "warning": 1, "info": 2, "style": 3}


def as_diagnostics(result):
    """Restate the totals as findings: n seen, n bad, nothing 'passed'.

    ruff's JUnit writer emits a placeholder `<testcase name="No errors found"/>`
    on a clean run, which otherwise lands in the record as a phantom passing
    test — and reads as `PASS 1/1` for a directory holding no Python at all.
    """
    found = len(result.failures)
    result.totals.update(dict.fromkeys(TOTAL_KEYS, 0))
    result.totals.update(tests=found, fail=found)
    return result


def parse_ruff(stdout, result):
    """ruff --output-format=json -> Result. Fills `result` in place.

    Its own format rather than rdjson or junit: rdjson drops the per-finding
    severity and the fix's applicability, and junit — which tq used to reparse —
    cannot carry a column, a severity, a rule url or a fix at all, so the rule
    code had to be dug back out of a mangled classname.
    """
    try:
        findings = json.loads(stdout or "")
    except ValueError:
        return result  # not JSON: leave it to the caller's raw-output fallback
    if not isinstance(findings, list):
        return result
    ordered = sorted(
        findings,
        key=lambda f: (
            LEVEL_RANK.get((f.get("severity") or "error").lower(), len(LEVEL_RANK)),
            f.get("filename") or "",
            (f.get("location") or {}).get("row") or 0,
            (f.get("location") or {}).get("column") or 0,
        ),
    )
    for note in ordered:
        start = note.get("location") or {}
        end = note.get("end_location") or {}
        fix = note.get("fix") or {}
        result.failures.append(
            Failure(
                name=note.get("code") or "ruff",
                file=note.get("filename"),
                line=start.get("row"),
                column=start.get("column"),
                end_line=end.get("row"),
                end_column=end.get("column"),
                severity=(note.get("severity") or "error").lower(),
                code_url=note.get("url"),
                source="ruff",
                fixable=fix.get("applicability"),
                message=(note.get("message") or "").strip(),
            )
        )
    return result


def parse_shellcheck(stdout, result):
    """shellcheck --format=json1 -> Result. Fills `result` in place.

    json1 rather than json: the latter is a bare top-level array, which gives
    nothing to distinguish "no findings" from "wrote nothing at all".
    """
    try:
        payload = json.loads(stdout or "")
    except ValueError:
        return result  # not JSON: leave it to the caller's raw-output fallback
    comments = payload.get("comments")
    if comments is None:
        return result
    ordered = sorted(
        comments,
        key=lambda c: (
            LEVEL_RANK.get(c.get("level"), len(LEVEL_RANK)),
            c.get("file") or "",
            c.get("line") or 0,
            c.get("column") or 0,
        ),
    )
    for note in ordered:
        code = note.get("code")
        result.failures.append(
            Failure(
                name=f"SC{code}" if code is not None else "shellcheck",
                file=note.get("file"),
                line=note.get("line"),
                column=note.get("column"),
                end_line=note.get("endLine"),
                end_column=note.get("endColumn"),
                severity=note.get("level") or "warning",
                # shellcheck states no url, but its wiki is addressed by code.
                code_url=(
                    f"https://www.shellcheck.net/wiki/SC{code}"
                    if code is not None
                    else None
                ),
                source="shellcheck",
                fixable="safe" if note.get("fix") else None,
                message=(note.get("message") or "").strip(),
            )
        )
    return result
