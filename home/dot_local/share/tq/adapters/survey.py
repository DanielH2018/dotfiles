"""The five surveys: paths swept, matches found, files changed, commits listed,
and records logged.

None of these has a verdict to report. A test run answers "did it hold"; a
sweep answers "how much is there and where", and the digest that serves it is a
count, a shape, and a sample — with every row kept in the json, because the
question after "how many" is almost always "which ones".
"""

from __future__ import annotations

import datetime
import json
import re

from result import Item, strip_ansi

# `added<TAB>deleted<TAB>path`, git's numstat row. A binary file has no line
# counts and git writes "-" for both rather than 0, which is the difference
# between "no lines changed" and "lines are not the unit here".
NUMSTAT = re.compile(r"^(\d+|-)\t(\d+|-)\t(.*)$")

# What tq puts in front of each commit so the numstat rows following it can be
# told from it. \x1e is the ASCII record separator and cannot appear in a
# subject, which git takes as the first line of the message and nothing more.
COMMIT_MARK = "\x1e"
FIELD_MARK = "\x1f"


def _count(raw):
    return None if raw == "-" else int(raw)


def lines(text):
    """Split on newlines and nothing else.

    str.splitlines() also breaks on form feed, the record and group separators,
    and NEL — so a source file with an Emacs page break in it would have one
    grep hit counted as two, and the \\x1e that marks a commit here would be
    eaten as a line ending before anything could look for it.
    """
    return (text or "").split("\n")


def parse_paths(stdout, result):
    """One path per record, NUL-separated when tq was able to ask for that and
    newline-separated when it was not — see FIND_OPERATORS for the case where
    asking would have changed which paths came back."""
    sep = "\0" if "\0" in stdout else "\n"
    for line in stdout.split(sep):
        path = line.strip("\n") if sep == "\0" else line
        if path:
            result.items.append(Item(path=path))
    return result


def parse_ls_r(stdout, result):
    """`ls -R`, which reports a directory as a header and its entries as bare
    names beneath it.

    The names are joined back onto the header they appeared under; a bare name
    is not a path, and a digest that grouped by it would put every `__init__.py`
    in the tree in one bucket.
    """
    current = ""
    for line in lines(strip_ansi(stdout)):
        line = line.rstrip()
        if not line:
            continue
        if line.endswith(":"):
            current = line[:-1]
            continue
        result.items.append(Item(path=f"{current}/{line}" if current else line))
    return result


def parse_rg_json(stdout, result):
    """ripgrep's NDJSON stream. Only the match events are rows; the begin, end
    and summary events describe the search rather than its results."""
    for line in lines(stdout):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue  # a partial last line from a killed run is not a match
        if event.get("type") != "match":
            continue
        data = event["data"]
        result.items.append(
            Item(
                path=_rg_text(data.get("path")),
                line=data.get("line_number"),
                text=(_rg_text(data.get("lines")) or "").rstrip("\n"),
                # One line can match more than once, and the honest total counts
                # both — rg's own summary does, so a digest that counted lines
                # would disagree with the tool it just ran.
                matches=len(data.get("submatches") or []) or 1,
            )
        )
    return result


def _rg_text(field):
    """rg writes a path as {"text": ...}, or as {"bytes": ...} when it is not
    valid UTF-8. The second is rare enough to name rather than decode."""
    if not isinstance(field, dict):
        return None
    if "text" in field:
        return field["text"]
    return "<non-utf8 path>" if "bytes" in field else None


def parse_grep(stdout, result):
    """grep's `path<NUL>line:text`, with the colon form as the fallback.

    --null is what makes the path unambiguous, and both GNU grep and ugrep
    accept it under that name. Without it a path containing a colon and a line
    of text are the same string, so the colon form splits on the first colon
    and can only be as right as the paths allow.
    """
    for line in lines(strip_ansi(stdout)):
        if not line:
            continue
        if "\0" in line:
            path, _, rest = line.partition("\0")
        else:
            path, _, rest = line.partition(":")
            if not rest:
                continue
        number, _, text = rest.partition(":")
        result.items.append(
            Item(
                path=path,
                line=int(number) if number.isdigit() else None,
                text=text if number.isdigit() else rest,
                matches=1,
            )
        )
    return result


# The per-user systemd manager, which owns every process in a desktop session
# and so groups nothing. See parse_journal.
USER_MANAGER = re.compile(r"^user@\d+\.service$")

# syslog severities, by the number journald actually stores. Rendered by name
# because "3" is only a severity to someone who has the table memorised, and the
# whole point of the digest is that it can be read without one.
PRIORITY_NAMES = {
    "0": "emerg",
    "1": "alert",
    "2": "crit",
    "3": "err",
    "4": "warning",
    "5": "notice",
    "6": "info",
    "7": "debug",
}

# The signals a core dump is actually attributable to. Anything else is reported
# by number rather than guessed at — the list is platform-specific below these,
# and a wrong name on a crash report is worse than a bare number.
SIGNAL_NAMES = {
    3: "SIGQUIT",
    4: "SIGILL",
    6: "SIGABRT",
    7: "SIGBUS",
    8: "SIGFPE",
    11: "SIGSEGV",
    31: "SIGSYS",
}


def _stamp(micros):
    """journald's microseconds-since-epoch as something a reader can place.

    Local time, because that is what `journalctl` and `coredumpctl` print
    themselves — a digest that silently switched to UTC would put every record
    an hour or several from where the bare command just said it was.
    """
    try:
        seconds = int(micros) / 1_000_000
    except (TypeError, ValueError):
        return ""
    try:
        return datetime.datetime.fromtimestamp(seconds).strftime("%Y-%m-%d %H:%M:%S")
    except (OSError, OverflowError, ValueError):
        return ""


def _journal_text(field):
    """journald's MESSAGE, which is not always a string.

    A message whose bytes are not valid UTF-8 is exported as an array of
    integers rather than text. Rendering that list with str() would put
    "[72, 105]" in the digest, so the bytes are decoded the same lossy way the
    rest of tq reads a subprocess.
    """
    if isinstance(field, str):
        return field
    if isinstance(field, list):
        try:
            return bytes(bytearray(field)).decode("utf-8", "replace")
        except (TypeError, ValueError):
            return ""
    return "" if field is None else str(field)


def parse_journal(stdout, result):
    """`journalctl -o json`: one JSON object per line, one line per record.

    The grouping key falls back through _SYSTEMD_UNIT, SYSLOG_IDENTIFIER and
    _COMM because the first is absent on exactly the records most worth
    grouping — kernel messages belong to no unit, and bucketing them all under
    "?" would collapse the one histogram a boot-time query is asked for.

    USER_MANAGER is skipped for the same reason in reverse. Every process in a
    desktop session — each app, each helper — reports _SYSTEMD_UNIT as the one
    `user@1000.service` that manages them all, so on a workstation journal it is
    a bucket holding nearly every record, which is no grouping at all. The
    identifier underneath it names the actual program.
    """
    for line in lines(stdout):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue  # a partial last line from a killed run is not a record
        if not isinstance(event, dict):
            continue
        unit = event.get("_SYSTEMD_UNIT") or ""
        if USER_MANAGER.match(unit):
            unit = ""
        source = unit or event.get("SYSLOG_IDENTIFIER") or event.get("_COMM") or "?"
        priority = str(event.get("PRIORITY", ""))
        result.items.append(
            Item(
                path=source,
                text=_journal_text(event.get("MESSAGE")).rstrip("\n"),
                date=_stamp(event.get("__REALTIME_TIMESTAMP")),
                status=PRIORITY_NAMES.get(priority, priority),
                matches=1,
            )
        )
    return result


def parse_coredumps(stdout, result):
    """`coredumpctl list --json=short`: one JSON array of crash records.

    Keyed on the executable rather than the pid: the pid is unique per crash and
    a histogram over it would have one bucket per row, where the question a
    crash list is asked is which program is failing repeatedly.
    """
    try:
        rows = json.loads(stdout or "[]")
    except ValueError:
        return result  # not the listing tq asked for: claim nothing
    if not isinstance(rows, list):
        return result
    for row in rows:
        if not isinstance(row, dict):
            continue
        signal = row.get("sig")
        name = SIGNAL_NAMES.get(signal, f"sig {signal}" if signal is not None else "?")
        # "missing" is worth carrying: a listed crash whose core was never
        # written cannot be debugged, and that is not visible from the count.
        core = row.get("corefile") or "?"
        detail = f"pid {row['pid']}" if row.get("pid") is not None else ""
        if core != "present":
            detail = f"{detail}, core {core}".lstrip(", ")
        result.items.append(
            Item(
                path=row.get("exe") or "?",
                text=detail,
                date=_stamp(row.get("time")),
                status=name,
                matches=1,
            )
        )
    return result


def parse_numstat(stdout, result):
    """`git diff --numstat -z`: NUL-terminated records of added, deleted, path.

    A rename writes the path field empty and follows it with the old and new
    names as two further records, which is why this walks the list with an
    index rather than looping over it.
    """
    parts = stdout.split("\0")
    i = 0
    while i < len(parts):
        row = NUMSTAT.match(parts[i])
        if not row:
            i += 1
            continue
        added, deleted, path = row.group(1), row.group(2), row.group(3)
        old_path, status = None, "M"
        if not path and i + 2 < len(parts):
            old_path, path = parts[i + 1], parts[i + 2]
            status = "R"
            i += 2
        result.items.append(
            Item(
                path=path,
                added=_count(added),
                deleted=_count(deleted),
                status=status,
                old_path=old_path,
            )
        )
        i += 1
    return result


def parse_commits(stdout, result):
    """The structured log tq asked for: a marked header per commit, and the
    numstat rows that belong to it in between, when file detail was wanted."""
    current = None
    for line in lines(stdout):
        if line.startswith(COMMIT_MARK):
            fields = line[len(COMMIT_MARK) :].split(FIELD_MARK)
            if len(fields) < 4:
                continue
            current = Item(
                sha=fields[0],
                author=fields[1],
                date=fields[2],
                text=FIELD_MARK.join(fields[3:]),
                added=0,
                deleted=0,
                matches=0,
            )
            result.items.append(current)
            continue
        row = NUMSTAT.match(line)
        if row and current is not None:
            current.added += _count(row.group(1)) or 0
            current.deleted += _count(row.group(2)) or 0
            # Files touched, counted here because the rows themselves are not
            # kept: a 500-commit log would carry more paths than the digest and
            # the json together have any use for.
            current.matches += 1
    return result
