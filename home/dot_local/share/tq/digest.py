"""Result -> the compact text that actually reaches the agent."""

from __future__ import annotations

import os

from result import cap, shorten

MAX_FAILURES = 10
MAX_OUTPUT = 2000
MAX_NOTE = 500


def plural(count, noun):
    return noun if count == 1 else noun + "s"


def lint_headline(result):
    """A linter's verdict is a count of diagnostics, not a pass rate: there is
    no denominator to report, because nothing was asserted about the lines it
    stayed quiet about."""
    seconds = result.duration_ms / 1000
    found = len(result.failures)
    if not found:
        if result.exit != 0:
            # The lint-shaped false pass: the tool broke — bad config, no such
            # file, an unreadable rule — and printing CLEAN would bless it.
            return f"NO FINDINGS PARSED  {seconds:.1f}s"
        return f"CLEAN  {seconds:.1f}s"
    files = len({f.file for f in result.failures if f.file})
    where = f" in {files} {plural(files, 'file')}" if files else ""
    return f"FAIL {found} {plural(found, 'finding')}{where}  {seconds:.1f}s"


def headline(result):
    if result.kind == "lint":
        return lint_headline(result)
    t = result.totals
    seconds = result.duration_ms / 1000
    if not t["tests"]:
        # Never dress an empty run as a pass. A filter that matched nothing and
        # a runner that collected nothing look identical from here, and the
        # second one is the dangerous one.
        return f"NO TESTS RAN  {seconds:.1f}s"
    verdict = "PASS" if result.exit == 0 and t["fail"] == 0 else "FAIL"
    counter = t["pass"] if verdict == "PASS" else t["fail"]
    notes = [
        f"{t[key]} {label}"
        for key, label in (
            ("skip", "skipped"),
            ("xfail", "xfailed"),
            ("xpass", "xpassed"),
        )
        if t[key]
    ]
    note = f"  ({', '.join(notes)})" if notes else ""
    return f"{verdict} {counter}/{t['tests']}{note}  {seconds:.1f}s"


def _output_block(label, text, scope, out):
    """One captured stream, inline when it is a single line."""
    body, dropped = cap(text.strip(), MAX_OUTPUT)
    if not body:
        return 0
    tag = f"{label} ({scope})" if scope else label
    lines = body.splitlines()
    if len(lines) == 1:
        out.append(f"  {tag}: {lines[0]}")
    else:
        out.append(f"  {tag}:")
        out.extend(f"    {line}" for line in lines)
    if dropped:
        out.append(f"    … +{dropped} bytes (see json)")
    return dropped


def digest(result, json_path):
    out = [headline(result)]
    for note in result.notes:
        body, dropped = cap(note.strip(), MAX_NOTE)
        for line in body.splitlines():
            out.append(f"note: {line}")
        if dropped:
            out.append(f"note: … +{dropped} bytes (see json)")
    if not result.failures:
        if result.exit != 0:
            out.append(f"runner exited {result.exit} with no reported failures")
        return "\n".join(out)

    shown = result.failures[:MAX_FAILURES]
    result.truncated["failures"] = len(result.failures) - len(shown)
    dropped_bytes = 0
    out.append("")
    for fail in shown:
        where = shorten(fail.file, result.cwd) or "?"
        # node names a file-level failure after the file; don't say it twice.
        same = os.path.basename(fail.name) == os.path.basename(where)
        label = "" if same else f"  {fail.name}"
        if fail.line:
            where = f"{where}:{fail.line}"
        out.append(f"{where}{label}")
        out.extend(f"  {line}" for line in fail.message.splitlines())
        dropped_bytes += _output_block("stdout", fail.stdout, fail.scope, out)
        if not fail.recovered:
            dropped_bytes += _output_block("stderr", fail.stderr, fail.scope, out)
        out.append("")

    result.truncated["stdout_bytes"] = dropped_bytes
    if result.truncated["failures"]:
        out.append(f"… {result.truncated['failures']} more failures in the json")
    out.append(f"json: {json_path}")
    return "\n".join(out)
