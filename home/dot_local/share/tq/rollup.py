"""Many survey rows -> a histogram and a sample of them.

Split out of digest.py, which owns the rest of a digest and calls survey_digest()
once. The two halves answer different questions: a headline says how much there
is, while everything here decides what to show when the rows themselves will not
fit. That is the part with the arithmetic in it -- bucket depth, even spacing,
byte ceilings -- and it is worth reading without the surrounding formatting.

plural lives in result.py rather than here because digest.py needs it too, and
importing it back out of this module would make the two circular.
"""

from __future__ import annotations

import os

from result import cap, plural

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
