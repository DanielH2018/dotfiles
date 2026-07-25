"""JUnit XML -> Result. Serves pytest and any other runner that emits JUnit."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from result import Failure, strip_ansi

FRAME = re.compile(r"^(?P<file>[^\s:][^:]*):(?P<line>\d+): in \S+", re.MULTILINE)
CAPTURED = re.compile(r"^-+ Captured (?:Out|Err) -+$", re.MULTILINE)
# A SyntaxError or other collection failure buries the real location in the "E "
# block, because every traceback frame above it belongs to the importer.
E_LOC = re.compile(r'^E\s+File "(?P<file>[^"]+)", line (?P<line>\d+)', re.MULTILINE)
E_LINE = re.compile(r"^E\s+(?P<msg>\S.*)$", re.MULTILINE)
# Frames never worth blaming: pytest internals, the stdlib, frozen bootstrap.
NOISE = ("/site-packages/", "/lib/python", "<frozen ")
GENERIC = {"collection failure", "", "failed"}
IN_SECONDS = re.compile(r"\bin \d+\.\d+s")
COUNT = re.compile(r"(\d+) (passed|failed|xfailed|xpassed|skipped|error|errors)\b")


def looks_like_path(text):
    """Whether a JUnit @name is really a filename. ruff names each testsuite
    after the file it linted, so that is the only place the full path survives —
    its @classname has the extension stripped. pytest names its suite "pytest",
    which must never be mistaken for a location."""
    if not text:
        return False
    base = text.replace("\\", "/").rsplit("/", 1)[-1]
    return "/" in text or "\\" in text or "." in base


def pick_frame(body, fallback):
    """Deepest frame in the user's own code, else the E-block, else the deepest
    frame at all. Naive last-frame-wins blames the stdlib for a user typo."""
    frames = FRAME.findall(body)
    own = [f for f in frames if not any(n in f[0] for n in NOISE)]
    if own:
        return own[-1][0], int(own[-1][1])
    located = list(E_LOC.finditer(body))
    if located:
        return located[-1].group("file"), int(located[-1].group("line"))
    if frames:
        return frames[-1][0], int(frames[-1][1])
    return fallback, None


def pick_message(attr_message, body):
    """The failure@message attribute, unless it says nothing useful."""
    message = strip_ansi(attr_message or "").strip()
    if message.lower() not in GENERIC:
        return message
    lines = [m.group("msg").rstrip() for m in E_LINE.finditer(body)]
    real = [ln for ln in lines if not ln.startswith(("File ", "^"))]
    return "\n".join(real or lines) or message or "failed"


def captured(element, tag):
    text = element.findtext(tag)
    return CAPTURED.sub("", strip_ansi(text)).strip() if text else ""


def marker_counts(summary_text):
    """pytest's terminal summary line is the only place a non-strict xpass shows
    up — in JUnit XML it is byte-identical to an ordinary pass."""
    lines = [
        ln
        for ln in strip_ansi(summary_text or "").splitlines()
        if IN_SECONDS.search(ln)
    ]
    if not lines:
        return {}
    return {name: int(n) for n, name in COUNT.findall(lines[-1])}


def parse(xml_path, result, summary_text=""):
    """Fill `result` in place. Returns it for convenience."""
    root = ET.parse(xml_path).getroot()
    tests = failed = skipped = 0
    seconds = 0.0
    for suite in root.iter("testsuite"):
        tests += int(suite.get("tests", 0))
        failed += int(suite.get("failures", 0)) + int(suite.get("errors", 0))
        skipped += int(suite.get("skipped", 0))
        seconds += float(suite.get("time", 0) or 0)
        suite_file = suite.get("name") if looks_like_path(suite.get("name")) else None
        for case in suite.iter("testcase"):
            bad = case.find("failure")
            if bad is None:
                bad = case.find("error")
            if bad is None:
                continue
            body = strip_ansi(bad.text or "")
            # A strict XPASS has no traceback at all — nothing failed — and
            # xunit2 omits @file, so classname is the only location left.
            fallback = case.get("file") or suite_file or case.get("classname")
            path, line = pick_frame(body, fallback)
            if line is None and case.get("line"):
                # No traceback to mine, so trust the attributes: a linter states
                # the location that way and never writes a frame. Consulted only
                # after pick_frame comes up empty, so pytest's own @line — which
                # is 0-based, and points at the test declaration rather than the
                # failing assert — can never override a real frame.
                line = int(case.get("line"))
            result.failures.append(
                Failure(
                    name=case.get("name") or "?",
                    file=path,
                    line=line,
                    message=pick_message(bad.get("message"), body),
                    stdout=captured(case, "system-out"),
                    stderr=captured(case, "system-err"),
                )
            )

    markers = marker_counts(summary_text)
    # xfail lands in the suite's skipped count and a non-strict xpass in its
    # passed count; break both out so the totals stay a true partition.
    xfail = min(markers.get("xfailed", 0), skipped)
    passed = tests - failed - skipped
    xpass = min(markers.get("xpassed", 0), max(passed, 0))
    result.duration_ms = int(seconds * 1000)
    result.totals.update(
        tests=tests,
        fail=failed,
        skip=skipped - xfail,
        xfail=xfail,
        xpass=xpass,
        **{"pass": passed - xpass},
    )
    return result
