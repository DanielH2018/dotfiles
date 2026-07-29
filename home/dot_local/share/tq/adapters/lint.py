"""Linter diagnostics -> Result, for tools that report findings rather than tests.

The shapes differ enough to matter: a test runner tells you how many things it
checked and how many held, so a digest can say 651/665. A linter only ever names
what is wrong. There is no denominator — silence about a line is not a passing
assertion about it — so these runs get counted, never scored.
"""

from __future__ import annotations

import json
import re

from result import TOTAL_KEYS, Failure

# Worst first, so that when a run overflows the digest's failure cap it is the
# errors that survive and the style nits that get pushed into the json.
LEVEL_RANK = {"error": 0, "warning": 1, "info": 2, "style": 3}

# tsc's default (non---pretty) diagnostic line: `path(line,col): error TSxxxx: msg`.
# The file half is non-greedy so a path holding a literal "(" still stops at the
# first "(line,col)" rather than swallowing it.
TSC_DIAGNOSTIC = re.compile(
    r"^(?P<file>.+?)\((?P<line>\d+),(?P<column>\d+)\): "
    r"(?P<severity>error|warning) TS(?P<code>\d+): (?P<message>.*)$"
)


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


def parse_mypy(stdout, result):
    """mypy --output=json -> Result. Fills `result` in place.

    JSON Lines rather than a single document: mypy writes one object per
    diagnostic as it finds it, with no enclosing array to make the stream valid
    JSON only once the run has finished.
    """
    findings = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            findings.append(json.loads(line))
        except ValueError:
            continue  # a note mypy printed outside --output=json, or a partial line
    ordered = sorted(
        findings,
        key=lambda f: (
            LEVEL_RANK.get((f.get("severity") or "error").lower(), len(LEVEL_RANK)),
            f.get("file") or "",
            f.get("line") or 0,
            f.get("column") or 0,
        ),
    )
    for note in ordered:
        result.failures.append(
            Failure(
                name=note.get("code") or "mypy",
                file=note.get("file"),
                line=note.get("line"),
                column=note.get("column"),
                severity=(note.get("severity") or "error").lower(),
                source="mypy",
                message=(note.get("message") or "").strip(),
            )
        )
    return result


def parse_tsc(stdout, result):
    """tsc's default stdout -> Result. Fills `result` in place.

    No JSON mode exists, so this reads the one tsc actually writes when stdout
    is not a tty: one `path(line,col): error|warning TSxxxx: message` line per
    diagnostic. A related-information line tsc prints under an overload error
    has no code of its own, so it is not a second finding — it is folded into
    the message of the diagnostic above it, rather than invented into structure
    tsc never gave it. A blank line ends nothing; it is just not itself a
    continuation, so it is skipped without being appended.
    """
    findings = []
    for line in (stdout or "").splitlines():
        match = TSC_DIAGNOSTIC.match(line)
        if match:
            findings.append(
                {
                    "file": match.group("file"),
                    "line": int(match.group("line")),
                    "column": int(match.group("column")),
                    "severity": match.group("severity"),
                    "code": match.group("code"),
                    "message": match.group("message").strip(),
                }
            )
            continue
        if not line.strip():
            continue
        if findings:
            findings[-1]["message"] += " " + line.strip()
    ordered = sorted(
        findings,
        key=lambda f: (
            LEVEL_RANK.get(f["severity"], len(LEVEL_RANK)),
            f["file"],
            f["line"],
            f["column"],
        ),
    )
    for note in ordered:
        result.failures.append(
            Failure(
                name=f"TS{note['code']}",
                file=note["file"],
                line=note["line"],
                column=note["column"],
                severity=note["severity"],
                source="tsc",
                message=note["message"],
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


ESLINT_SEVERITY = {1: "warning", 2: "error"}


def parse_eslint(stdout, result):
    """eslint --format=json -> Result. Fills `result` in place.

    A top-level array of per-file results, each carrying its own `messages`
    array — flattened here into the one findings list every other adapter
    produces. A rule-less fatal message (a syntax error eslint could not even
    parse past) still gets a name: "eslint" rather than a missing ruleId.
    """
    try:
        payload = json.loads(stdout or "")
    except ValueError:
        return result  # not JSON: leave it to the caller's raw-output fallback
    if not isinstance(payload, list):
        return result
    findings = [
        (entry.get("filePath"), note)
        for entry in payload
        for note in entry.get("messages") or []
    ]
    ordered = sorted(
        findings,
        key=lambda fn: (
            LEVEL_RANK.get(ESLINT_SEVERITY.get(fn[1].get("severity"), "error"), 0),
            fn[0] or "",
            fn[1].get("line") or 0,
            fn[1].get("column") or 0,
        ),
    )
    for file_path, note in ordered:
        result.failures.append(
            Failure(
                name=note.get("ruleId") or "eslint",
                file=file_path,
                line=note.get("line"),
                column=note.get("column"),
                end_line=note.get("endLine"),
                end_column=note.get("endColumn"),
                severity=ESLINT_SEVERITY.get(note.get("severity"), "error"),
                source="eslint",
                # eslint states no per-message safety, only whether a fix exists.
                fixable="unsafe" if note.get("fix") else None,
                message=(note.get("message") or "").strip(),
            )
        )
    return result
