"""Result -> the compact text that actually reaches the agent."""

from __future__ import annotations

import os

from result import cap, shorten

MAX_FAILURES = 10
MAX_OUTPUT = 2000
MAX_NOTE = 500
MAX_MESSAGE = 2000
# Surveys. A sweep small enough to print is printed whole — a histogram of nine
# paths is strictly worse than the nine paths, and tq is only worth putting in
# front of a command when it says less than the command would have.
MAX_ROWS = 40
MAX_ROWS_BYTES = 2000
# Buckets in a histogram, and how deep a directory key may go to fill them.
MAX_BUCKETS = 12
MAX_DIR_DEPTH = 4
SAMPLE = 8
MAX_ROW_TEXT = 120
SURVEY_KINDS = ("paths", "matches", "diff", "commits", "records")
# A ceiling on the whole digest, not just on each part of it. Ten failures each
# allowed a capped message plus two capped streams is ~40KB, and the tool result
# tq's output lands in is capped again below that — so without a total the
# harness does the trimming instead, from the end, where the json path lives.
MAX_DIGEST = 12000


def plural(count, noun):
    if count == 1:
        return noun
    # "matchs" and "directorys" are what appending an s alone produced, and a
    # digest that cannot spell what it counted reads as a broken tool whatever
    # the number to the left of it says.
    if noun.endswith(("ch", "sh", "s", "x")):
        return noun + "es"
    if noun.endswith("y") and not noun.endswith(("ay", "ey", "oy", "uy")):
        return noun[:-1] + "ies"
    return noun + "s"


def _size(lines):
    return sum(len(line.encode("utf-8")) + 1 for line in lines)


def lint_headline(result):
    """A linter's verdict is a count of diagnostics, not a pass rate: there is
    no denominator to report, because nothing was asserted about the lines it
    stayed quiet about."""
    seconds = result.duration_ms / 1000
    found = len(result.failures)
    aside = result.truncated.get("out_of_scope") or 0
    if not found:
        if aside:
            # Ahead of the exit check: a linter that found things exits non-zero
            # even when every one of them was scoped away, and NO FINDINGS
            # PARSED would report a working tool as a broken one. Bare CLEAN is
            # equally wrong — the diff is clean, the repo demonstrably is not.
            return f"CLEAN in your diff  ({aside} outside it)  {seconds:.1f}s"
        if result.exit != 0:
            # The lint-shaped false pass: the tool broke — bad config, no such
            # file, an unreadable rule — and printing CLEAN would bless it.
            return f"NO FINDINGS PARSED  {seconds:.1f}s"
        return f"CLEAN  {seconds:.1f}s"
    files = len({f.file for f in result.failures if f.file})
    where = f" in {files} {plural(files, 'file')}" if files else ""
    scoped = f"  ({aside} outside your diff)" if aside else ""
    return f"FAIL {found} {plural(found, 'finding')}{where}{scoped}  {seconds:.1f}s"


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
    elif result.kind in SURVEY_KINDS:
        rows = len(result.items)
        so_far = f"  ({rows:,} found before the cut)" if rows else ""
    else:
        ran = result.totals["tests"]
        so_far = f"  ({ran} {plural(ran, 'test')} completed)" if ran else ""
    return f"TIMED OUT after {seconds:.0f}s{so_far}"


def survey_headline(result):
    """How much there is, and what stops that being the whole answer.

    A survey asserts nothing, so it has no pass or fail to report — but a count
    can still lie in two directions, and both are named here rather than left
    for the reader to infer. It is short of the truth when the command capped
    itself, and it is not a count of anything when the command failed.
    """
    seconds = result.duration_ms / 1000
    n = len(result.items)
    if result.kind == "matches":
        files = len({i.path for i in result.items if i.path})
        total = sum(i.matches or 1 for i in result.items)
        # Exit 1 is how every grep says "nothing matched", which is an answer.
        # Anything above it is the tool failing, and "0 matches" would report a
        # broken search as an exhaustive one.
        if not n and result.exit > 1:
            return f"NO MATCHES PARSED  (exited {result.exit})  {seconds:.1f}s"
        if not n:
            return f"no matches  {seconds:.1f}s"
        body = f"{total:,} {plural(total, 'match')}"
        if total != n:
            # A line matched twice is two matches and one row. The histogram
            # below counts matches and the sample counts rows, so with only the
            # larger figure in the headline the two disagree by a number the
            # reader has no way to account for.
            body = f"{body} on {n:,} {plural(n, 'line')}"
        body = f"{body} in {files:,} {plural(files, 'file')}"
    elif result.kind == "diff":
        added = sum(i.added or 0 for i in result.items)
        deleted = sum(i.deleted or 0 for i in result.items)
        if not n:
            return f"no changes  {seconds:.1f}s"
        body = f"{n:,} {plural(n, 'file')} changed, +{added:,} −{deleted:,}"
    elif result.kind == "commits":
        if not n:
            return f"no commits  {seconds:.1f}s"
        body = f"{n:,} {plural(n, 'commit')}"
        dates = sorted(i.date[:10] for i in result.items if i.date)
        if dates and dates[0] != dates[-1]:
            body = f"{body}  {dates[0]}..{dates[-1]}"
    elif result.kind == "records":
        # Exit 1 is how coredumpctl says "no coredumps", which for a crash list
        # is the healthy answer and by far the commonest one. Reporting it as a
        # failed enumeration would raise an alarm on every clean machine — the
        # same distinction the matches branch above draws for grep.
        if not n and result.exit > 1:
            return f"NO RECORDS PARSED  (exited {result.exit})  {seconds:.1f}s"
        if not n:
            return f"no records  {seconds:.1f}s"
        body = f"{n:,} {plural(n, 'record')}"
        dates = sorted(i.date for i in result.items if i.date)
        if dates and dates[0][:10] != dates[-1][:10]:
            body = f"{body}  {dates[0][:10]}..{dates[-1][:10]}"
        elif dates:
            body = f"{body}  {dates[0][:10]}"
    else:
        if not n and result.exit != 0:
            return f"NO PATHS PARSED  (exited {result.exit})  {seconds:.1f}s"
        if not n:
            return f"no paths  {seconds:.1f}s"
        body = f"{n:,} {plural(n, 'path')}"
    if result.limited:
        # The count is what the command was allowed to find, not what is there.
        body = f"{body}, the {result.limited} limit — there may be more"
    elif result.exit != 0:
        # A sweep that could not read part of the tree enumerated part of it.
        # Same rule as TIMED OUT: a partial pass over the ground has no total.
        body = f"{body} so far — exited {result.exit}, enumeration incomplete"
    return f"{body}  {seconds:.1f}s"


def _dir_key(path, depth):
    parts = (path or "").split("/")[:-1]
    return "/".join(parts[:depth]) or "."


def _dir_depth(paths):
    """How many path segments to group on.

    One segment is the obvious choice and is wrong whenever a sweep has a single
    root: `src/` for every row says nothing. Buckets only grow as the key gets
    longer, so the deepest key that still fits the histogram is the most it can
    say within the same number of lines.
    """
    best = 1
    for depth in range(1, MAX_DIR_DEPTH + 1):
        if len({_dir_key(p, depth) for p in paths}) > MAX_BUCKETS:
            break
        best = depth
    return best


def _tally(rows):
    """(key, count) pairs, heaviest first, ties broken by name so that two runs
    over the same tree produce the same digest."""
    counts = {}
    for key, weight in rows:
        counts[key] = counts.get(key, 0) + weight
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def _histogram(pairs, noun, unit, out):
    """The heaviest buckets, and an explicit accounting of the rest.

    The remainder line is the point. A top-ten list with the tail dropped reads
    as the whole distribution, and every conclusion drawn from it is wrong by
    however much was left off the bottom.

    One bucket is not a distribution — it restates the count in a second place —
    so nothing is drawn and the caller is told nothing was.
    """
    if len(pairs) < 2:
        return False
    width = max((len(key) for key, _ in pairs[:MAX_BUCKETS]), default=0)
    for key, count in pairs[:MAX_BUCKETS]:
        out.append(f"  {key.ljust(width)}  {count:>6,}")
    rest = pairs[MAX_BUCKETS:]
    if rest:
        total = sum(count for _, count in rest)
        out.append(
            f"  … +{len(rest):,} more {plural(len(rest), noun)}, "
            f"{total:,} {plural(total, unit)}"
        )
    return True


def _sample(items, size):
    """Evenly spaced through the list, not the front of it.

    find and ls walk depth-first and git log runs newest-first, so the first
    eight rows of any of them come from one corner of the answer. A reader shown
    the head infers a shape from it; a stride at least crosses the whole list.
    """
    if len(items) <= size:
        return list(items)
    if size == 1:
        return [items[0]]
    # Spread across the gaps rather than the length, so the last row is the last
    # item. Dividing by size instead put the final sample at 1235 of 1412 and
    # left the tail of every long sweep unseen — which is the end a truncated
    # answer is most often wrong about.
    step = (len(items) - 1) / (size - 1)
    return [items[round(i * step)] for i in range(size)]


def _row(item, kind):
    if kind == "matches":
        where = f"{item.path}:{item.line}" if item.line else (item.path or "?")
        text, _ = cap((item.text or "").strip(), MAX_ROW_TEXT)
        return f"{where}  {text}".rstrip()
    if kind == "diff":
        move = f"{item.old_path} → " if item.old_path else ""
        return f"{move}{item.path}  +{item.added or 0:,} −{item.deleted or 0:,}"
    if kind == "commits":
        text, _ = cap((item.text or "").strip(), MAX_ROW_TEXT)
        return f"{item.sha[:7]} {item.date[:10]} {text}".rstrip()
    if kind == "records":
        # Time first, because a record is read in sequence with its neighbours
        # and the severity is what decides whether it is read at all.
        when = item.date[11:] if len(item.date) > 11 else item.date
        text, _ = cap((item.text or "").strip(), MAX_ROW_TEXT)
        head = " ".join(part for part in (when, item.status, item.path) if part)
        return f"{head}  {text}".rstrip()
    return item.path or "?"


# What one row of each survey is, so a sample can say what it is a sample of.
# A matches row is a line, not a match: the same line can hold several.
ROW_NOUN = {
    "paths": "path",
    "matches": "matching line",
    "diff": "file",
    "commits": "commit",
    "records": "record",
}

JQ_HINTS = {
    "paths": ".items[].path",
    "matches": '.items[] | "\\(.path):\\(.line)  \\(.text)"',
    "diff": '.items[] | "\\(.added)\\t\\(.deleted)\\t\\(.path)"',
    "commits": '.items[] | "\\(.sha[0:7]) \\(.text)"',
    "records": '.items[] | "\\(.date) \\(.status) \\(.path)  \\(.text)"',
}


def survey_shape(result, out):
    """The histogram that stands in for the rows, one per kind."""
    if result.kind == "commits":
        _histogram(
            _tally([(i.author or "?", 1) for i in result.items]),
            "author",
            "commit",
            out,
        )
        return
    if result.kind == "diff":
        rows = [
            (i.path or "?", (i.added or 0) + (i.deleted or 0)) for i in result.items
        ]
        _histogram(_tally(rows), "file", "changed line", out)
        return
    if result.kind == "matches":
        _histogram(
            _tally([(i.path or "?", i.matches or 1) for i in result.items]),
            "file",
            "match",
            out,
        )
        return
    if result.kind == "records":
        drawn = _histogram(
            _tally([(i.path or "?", 1) for i in result.items]),
            "source",
            "record",
            out,
        )
        # Severity second, and only when it separates anything. A query already
        # narrowed to one priority — `journalctl -p err` — would spend the line
        # restating its own flag, which is the same rule the extension histogram
        # follows for a sweep that asked for one suffix.
        severities = _tally([(i.status or "?", 1) for i in result.items])
        if len(severities) > 1:
            if drawn:
                out.append("")
            _histogram(severities, "severity", "record", out)
        return
    paths = [i.path or "" for i in result.items]
    depth = _dir_depth(paths)
    drawn = _histogram(
        _tally([(_dir_key(p, depth), 1) for p in paths]), "directory", "path", out
    )
    exts = _tally([(os.path.splitext(p)[1] or "(none)", 1) for p in paths])
    # Only when it distinguishes anything. `.py 1,847` under a sweep that asked
    # for *.py is a line spent restating the command.
    if len(exts) > 1:
        if drawn:
            out.append("")
        _histogram(exts, "extension", "path", out)


def survey_digest(result, json_path, out):
    rows = [_row(item, result.kind) for item in result.items]
    body = "\n".join(f"  {row}" for row in rows)
    if rows and len(rows) <= MAX_ROWS and len(body.encode("utf-8")) <= MAX_ROWS_BYTES:
        # Everything, because everything fits. No json line and no jq hint:
        # nothing was withheld, so there is nothing to go and look up.
        out.append("")
        out.extend(f"  {row}" for row in rows)
        return "\n".join(out)
    out.append(f"json: {json_path}")
    if not result.items:
        return "\n".join(out)
    shape = []
    survey_shape(result, shape)
    if shape:
        out.append("")
        out.extend(shape)
    shown = _sample(result.items, SAMPLE)
    if len(shown) < len(result.items):
        noun = ROW_NOUN[result.kind]
        out.append("")
        out.append(
            f"sample ({len(shown)} of {len(result.items):,} "
            f"{plural(len(result.items), noun)}, evenly spaced):"
        )
        out.extend(f"  {_row(item, result.kind)}" for item in shown)
    out.append("")
    out.append(f"jq: jq -r '{JQ_HINTS[result.kind]}' {json_path}")
    return "\n".join(out)


def headline(result):
    if result.timed_out:
        return timeout_headline(result)
    if result.kind in SURVEY_KINDS:
        return survey_headline(result)
    if result.kind == "lint":
        return lint_headline(result)
    t = result.totals
    seconds = result.duration_ms / 1000
    if not t["tests"]:
        # Never dress an empty run as a pass. A filter that matched nothing and
        # a runner that collected nothing look identical from here, and the
        # second one is the dangerous one.
        return f"NO TESTS RAN  {seconds:.1f}s"
    # The recorded failures get a vote alongside the counts, because the two can
    # disagree and the count is the half that lies: a JUnit suite can carry
    # failures="0" over a <failure> child, and a runner that reports per-file
    # totals can leave the run-level ones short. Either way the block of failures
    # below this line would otherwise be printed under the word PASS.
    unforgiven = [f for f in result.failures if not f.flaky]
    passed = result.exit == 0 and t["fail"] == 0 and not unforgiven
    verdict = "PASS" if passed else "FAIL"
    counter = t["pass"] if passed else max(t["fail"], len(unforgiven))
    notes = [
        f"{t[key]} {label}"
        for key, label in (
            ("skip", "skipped"),
            ("xfail", "xfailed"),
            ("xpass", "xpassed"),
        )
        if t[key]
    ]
    flaky = sum(1 for f in result.failures if f.flaky)
    if flaky:
        notes.insert(0, f"{flaky} flaky")
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


def fix_note(result):
    """How many findings the tool offered to fix, and how many of those it
    considers safe. The split is the point: an unsafe fix changes behaviour, so
    "apply them all" is only ever right for the safe half."""
    fixable = [f for f in result.failures if f.fixable]
    if not fixable:
        return ""
    safe = sum(1 for f in fixable if f.fixable == "safe")
    count = f"{len(fixable)} auto-fixable"
    return f"{count} ({safe} safe)" if safe != len(fixable) else f"{count}, all safe"


def _failure_block(fail, cwd, out):
    """One failure's lines, appended to `out`. Returns the bytes dropped."""
    where = shorten(fail.file, cwd) or "?"
    # node names a file-level failure after the file; don't say it twice.
    same = os.path.basename(fail.name) == os.path.basename(where)
    label = "" if same else f"  {fail.name}"
    if fail.line:
        where = f"{where}:{fail.line}"
        if fail.column:
            where = f"{where}:{fail.column}"
    # A linter's severity is part of the finding; a test failure has no such
    # gradation and its default would be noise on every line.
    if fail.source and fail.severity and fail.severity != "error":
        label = f"{label}  {fail.severity}"
    out.append(f"{where}{label}")
    if fail.flaky:
        out.append("  FLAKY — failed, then passed on retry")
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
    if result.kind in SURVEY_KINDS:
        return survey_digest(result, json_path, out)
    if not result.failures:
        # Not when scoping emptied the list: the headline has already said the
        # findings exist and where they are, and "no reported failures" would
        # contradict it while describing the same run.
        if result.exit != 0 and not result.truncated.get("out_of_scope"):
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
        block_dropped = _failure_block(fail, result.cwd, block)
        # The first failure is rendered whole however large it is: naming a
        # failure while showing none of it barely beats saying nothing.
        if shown and used + _size(block) > MAX_DIGEST:
            break
        out.extend(block)
        used += _size(block)
        dropped_bytes += block_dropped
        shown += 1

    result.truncated["failures"] = len(result.failures) - shown
    result.truncated["stdout_bytes"] = dropped_bytes
    if result.truncated["failures"]:
        out.append(f"… {result.truncated['failures']} more failures in the json")
    fixes = fix_note(result)
    if fixes:
        out.append(fixes)
    return "\n".join(out)
