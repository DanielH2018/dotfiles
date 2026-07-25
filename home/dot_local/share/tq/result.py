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

    def to_dict(self):
        return {
            "file": self.file,
            "line": self.line,
            "name": self.name,
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
    duration_ms: int = 0
    totals: dict = field(default_factory=new_totals)
    failures: list = field(default_factory=list)
    truncated: dict = field(default_factory=lambda: {"failures": 0, "stdout_bytes": 0})

    def to_dict(self):
        return {
            "runner": self.runner,
            "cmd": self.cmd,
            "cwd": self.cwd,
            "exit": self.exit,
            "duration_ms": self.duration_ms,
            "totals": self.totals,
            "failures": [f.to_dict() for f in self.failures],
            "truncated": self.truncated,
        }

    def write(self, path):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2)
        return path
