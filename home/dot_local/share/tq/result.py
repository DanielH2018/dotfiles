"""The record every tq adapter produces, plus the text helpers they share."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

# Real escape sequences, plus the literal "#x1B" that pytest's bin_xml_escape
# writes when it rewrites ESC, which is not a legal XML 1.0 character. A plain
# \x1b-based pattern silently matches nothing in a JUnit file.
ANSI = re.compile(r"(?:\x1b|#x1B)\[[0-9;?]*[ -/]*[@-~]")

# tests = pass + fail + skip + xfail + xpass, each test counted exactly once.
TOTAL_KEYS = ("tests", "pass", "fail", "skip", "xfail", "xpass")


def new_totals():
    return dict.fromkeys(TOTAL_KEYS, 0)


def strip_ansi(text):
    return ANSI.sub("", text or "")


def shorten(path, start):
    """Relative to the run's cwd when that is shorter, else unchanged."""
    if not path:
        return path
    try:
        rel = os.path.relpath(path, start)
    except ValueError:  # different drives on Windows
        return path
    return rel if not rel.startswith("..") and len(rel) < len(path) else path


def cap(text, limit):
    """Trim to `limit` bytes, reporting how many were dropped."""
    raw = (text or "").encode("utf-8")
    if len(raw) <= limit:
        return text or "", 0
    return raw[:limit].decode("utf-8", "ignore"), len(raw) - limit


@dataclass
class Failure:
    name: str
    file: str | None = None
    line: int | None = None
    message: str = ""
    stdout: str = ""
    stderr: str = ""
    # True when `message` was distilled out of `stderr`, so the digest would only
    # be repeating itself by printing both.
    recovered: bool = field(default=False, repr=False)
    # Set when the captured output is attributed more coarsely than one test —
    # node reports stdout per file, and a digest must not imply otherwise.
    scope: str = field(default="", repr=False)
    # What a linter knows and a test runner does not. All optional: a test
    # failure leaves every one of them unset, so the two kinds of finding share
    # one record without either having to pretend to be the other.
    column: int | None = None
    end_line: int | None = None
    end_column: int | None = None
    severity: str = "error"
    # The rule's documentation. Worth more than the code alone to a reader who
    # can follow it, and the code alone is all JUnit was ever able to carry.
    code_url: str | None = None
    source: str | None = None
    # True when this failed on the first attempt and passed on a retry, the
    # code unchanged in between — a fact about the test, not about the change.
    flaky: bool = False
    # "safe" or "unsafe" where the tool says so — whether the fix can be applied
    # without reading it first is the part that decides what to do next.
    fixable: str | None = None

    def to_dict(self):
        return {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "end_line": self.end_line,
            "end_column": self.end_column,
            "name": self.name,
            "severity": self.severity,
            "code_url": self.code_url,
            "source": self.source,
            "fixable": self.fixable,
            "flaky": self.flaky,
            "message": self.message,
            "stdout": self.stdout,
            "stderr": self.stderr,
        }


@dataclass
class Result:
    runner: str
    cmd: str
    cwd: str
    exit: int
    # "tests" or "lint". A linter has no pass count — every line it emits is a
    # finding and a clean run emits nothing — so it cannot borrow the test
    # verdict without inventing passes that were never asserted.
    kind: str = "tests"
    # Set when the runner had to be killed for exceeding TQ_TIMEOUT. What was
    # collected up to that point is still worth reporting, but it is a partial
    # record and no verdict can be read off it.
    timed_out: bool = False
    duration_ms: int = 0
    # How many times the runner was asked. More than one only when a retry
    # was requested and there was something worth retrying.
    attempts: int = 1
    totals: dict = field(default_factory=new_totals)
    failures: list = field(default_factory=list)
    # Things the runner said that are not findings but change what the run
    # means: ruff warns "No Python files found under the given path(s)" on
    # stderr and still exits 0, which is a clean verdict over nothing at all.
    notes: list = field(default_factory=list)
    truncated: dict = field(
        default_factory=lambda: {"failures": 0, "stdout_bytes": 0, "out_of_scope": 0}
    )

    def to_dict(self):
        return {
            "runner": self.runner,
            "kind": self.kind,
            "cmd": self.cmd,
            "cwd": self.cwd,
            "exit": self.exit,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
            "attempts": self.attempts,
            "totals": self.totals,
            "failures": [f.to_dict() for f in self.failures],
            "notes": self.notes,
            "truncated": self.truncated,
        }

    def write(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2)
        return path
