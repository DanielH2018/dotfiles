"""Result -> the compact text that actually reaches the agent."""

from __future__ import annotations

import os

from result import cap, shorten

MAX_FAILURES = 10
MAX_OUTPUT = 2000
MAX_NOTE = 500
MAX_MESSAGE = 2000
# A ceiling on the whole digest, not just on each part of it. Ten failures each
# allowed a capped message plus two capped streams is ~40KB, and the tool result
# tq's output lands in is capped again below that — so without a total the
# harness does the trimming instead, from the end, where the json path lives.
MAX_DIGEST = 12000


def plural(count, noun):
    return noun if count == 1 else noun + "s"


def _size(lines):
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


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


def timeout_headline(result):
    """A run that was killed for running too long reports neither a verdict nor
    a total: it was cut off mid-flight, so the tests it never reached are not
    passes and the failures it never printed are not absences."""
    seconds = result.duration_ms / 1000
    if result.kind == "lint":
        found = len(result.failures)
        so_far = (
            f"  ({found} {plural(found, 'finding')} before the cut)" if found else ""
        )
    else:
        ran = result.totals["tests"]
        so_far = f"  ({ran} {plural(ran, 'test')} completed)" if ran else ""
    return f"TIMED OUT after {seconds:.0f}s{so_far}"


def headline(result):
    if result.timed_out:
        return timeout_headline(result)
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


def _failure_block(fail, cwd, out):
    """One failure's lines, appended to `out`. Returns the bytes dropped."""
    where = shorten(fail.file, cwd) or "?"
    # node names a file-level failure after the file; don't say it twice.
    same = os.path.basename(fail.name) == os.path.basename(where)
    label = "" if same else f"  {fail.name}"
    if fail.line:
        where = f"{where}:{fail.line}"
    out.append(f"{where}{label}")
    # An assertion diff over a large structure is unbounded, and one of them is
    # enough to spend the whole digest on a single failure.
    body, dropped = cap(fail.message, MAX_MESSAGE)
    out.extend(f"  {line}" for line in body.splitlines())
    if dropped:
        out.append(f"  … +{dropped} bytes (see json)")
    dropped += _output_block("stdout", fail.stdout, fail.scope, out)
    if not fail.recovered:
        dropped += _output_block("stderr", fail.stderr, fail.scope, out)
    out.append("")
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

    # Ahead of the detail rather than after it. Whatever tq writes is capped
    # again downstream, and a cap takes the tail — so the one line that cannot
    # be reconstructed from the lines around it goes where a cut cannot reach.
    out.append(f"json: {json_path}")
    out.append("")

    used, shown, dropped_bytes = _size(out), 0, 0
    for fail in result.failures[:MAX_FAILURES]:
        block = []
        dropped_bytes += _failure_block(fail, result.cwd, block)
        # The first failure is rendered whole however large it is: naming a
        # failure while showing none of it barely beats saying nothing.
        if shown and used + _size(block) > MAX_DIGEST:
            break
        out.extend(block)
        used += _size(block)
        shown += 1

    result.truncated["failures"] = len(result.failures) - shown
    result.truncated["stdout_bytes"] = dropped_bytes
    if result.truncated["failures"]:
        out.append(f"… {result.truncated['failures']} more failures in the json")
    return "\n".join(out)
