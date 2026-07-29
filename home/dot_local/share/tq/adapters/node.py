"""node --test NDJSON (written by node-reporter.mjs) -> Result."""

from __future__ import annotations

import json
import re

from result import Failure, strip_ansi

FRAME = re.compile(
    r"^\s*at (?:.*?\()?(?P<file>[^()\s][^()]*?):(?P<line>\d+):\d+\)?\s*$", re.MULTILINE
)
ERROR_HEAD = re.compile(r"^[A-Za-z_$][\w$]*(?:Error|Exception)\b.*$")
BANNER = re.compile(r"^Node\.js v\d")
THROW_SITE = re.compile(r"^(?P<file>[^\s:][^:]*):(?P<line>\d+)$")
# What the ERR_TEST_FAILURE wrapper says when the real error never survived the
# trip out of the test subprocess. The detail is in that file's stderr instead.
USELESS = {"", "test failed"}


def pick_frame(text):
    """Shallowest frame in the user's own code — node's own frames are noise."""
    for m in FRAME.finditer(text or ""):
        path = m.group("file")
        if path.startswith("node:") or "node_modules" in path:
            continue
        return path, int(m.group("line"))
    return None, None


def describe(error):
    """`name: message`, blank lines squeezed out of the assertion diff."""
    name = (error.get("name") or "").strip()
    lines = [
        ln for ln in strip_ansi(error.get("message") or "").splitlines() if ln.strip()
    ]
    if not lines:
        return name or "failed"
    head = lines[0] if not name or lines[0].startswith(name) else f"{name}: {lines[0]}"
    return "\n".join([head, *lines[1:]])


def recover(text):
    """Distil node's raw crash dump — throw-site preamble, stack frames, the
    property dump, the version banner — down to the error and its detail."""
    lines = [ln.rstrip() for ln in strip_ansi(text).splitlines()]
    start = next((i for i, ln in enumerate(lines) if ERROR_HEAD.match(ln)), None)
    if start is None:
        body = [ln for ln in lines if ln.strip() and not BANNER.match(ln)][-5:]
    else:
        body = []
        for line in lines[start:]:
            if FRAME.match(line):
                break
            if line.strip():
                body.append(line)
    path, line_no = pick_frame("\n".join(lines))
    if path is None and start:
        # A syntax error has no user frame at all; node names the throw site on
        # the line above the source excerpt instead.
        for line in reversed(lines[:start]):
            site = THROW_SITE.match(line)
            if site:
                return "\n".join(body), site.group("file"), int(site.group("line"))
    return "\n".join(body), path, line_no


def _read(ndjson_path):
    records = []
    with open(ndjson_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue  # a partial final line beats losing the whole run
    return records


def parse(ndjson_path, result):
    """Fill `result` in place. Returns it for convenience."""
    records = _read(ndjson_path)
    streams = {"out": {}, "err": {}}
    fails, summaries, todo_passed = [], [], 0
    for rec in records:
        kind = rec.get("t")
        if kind == "fail":
            fails.append(rec)
        elif kind == "pass":
            todo_passed += 1
        elif kind in ("out", "err"):
            streams[kind].setdefault(rec.get("file"), []).append(rec.get("text") or "")
        elif kind == "summary":
            summaries.append(rec)

    roots = [s for s in summaries if not s.get("file")]
    if roots:
        counts = roots[-1].get("counts") or {}
        result.duration_ms = int(roots[-1].get("duration_ms") or 0)
    elif summaries:
        # No run-level summary, so the per-file ones are the whole account and
        # have to be added up. Taking the last of them instead reports one
        # file's counts for the run, which reads as a small green suite.
        counts = {}
        for summary in summaries:
            for key, value in (summary.get("counts") or {}).items():
                counts[key] = counts.get(key, 0) + value
        result.duration_ms = max(
            (int(s.get("duration_ms") or 0) for s in summaries), default=0
        )
    if summaries:
        # node counts a todo test as todo and nowhere else, whether it passed or
        # failed — so the two halves partition cleanly into xpass and xfail.
        todo = counts.get("todo", 0)
        result.totals.update(
            tests=counts.get("tests", 0),
            fail=counts.get("failed", 0) + counts.get("cancelled", 0),
            **{"pass": counts.get("passed", 0)},
            skip=counts.get("skipped", 0),
            xpass=min(todo_passed, todo),
            xfail=max(todo - min(todo_passed, todo), 0),
        )

    charged = set()
    for rec in fails:
        if rec.get("todo"):
            continue  # a failing todo is node's xfail, already counted as such
        error = rec.get("error") or {}
        path, line = pick_frame(error.get("stack"))
        stderr_text = "".join(streams["err"].get(rec.get("file"), []))
        message, recovered = describe(error), False
        if (error.get("message") or "").strip() in USELESS and stderr_text:
            message, alt_path, alt_line = recover(stderr_text)
            path, line, recovered = path or alt_path, line or alt_line, True
        # A subprocess error carries its own streams and they belong to this one
        # test; test:stdout/test:stderr events only ever resolve to a whole file.
        if "stdout" in error or "stderr" in error:
            out_text, err_text, scope = (
                error.get("stdout", ""),
                error.get("stderr", ""),
                "",
            )
        else:
            first = rec.get("file") not in charged
            out_text = "".join(streams["out"].get(rec.get("file"), [])) if first else ""
            err_text, scope = (stderr_text if first else ""), "file"
            if first:
                charged.add(rec.get("file"))
        if err_text.strip() and err_text.strip() in message:
            err_text = ""  # node already folded it into the message
        result.failures.append(
            Failure(
                name=rec.get("name") or "?",
                file=path or rec.get("file"),
                line=line or (rec.get("defLine") if not path else None),
                message=message,
                stdout=out_text,
                stderr=err_text,
                recovered=recovered,
                scope=scope,
            )
        )
    return result
