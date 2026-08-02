"""Reading JSON in, rendering results out, and the wall-clock cap."""

import json
import os
import re
import signal
import sys

from _jsonq.errors import JsonqError
from _jsonq.functions import _dumps, _text
from _jsonq.limits import SECRET_PATHS


def _check_readable(path):
    """Refuse secret paths. Both the given path and its realpath are tested, so
    a symlink pointing at ~/.ssh/id_rsa can't launder the name."""
    expanded = os.path.expanduser(path)
    for candidate in (expanded, os.path.realpath(expanded)):
        if re.search(SECRET_PATHS, candidate):
            raise JsonqError(f"refusing to read {path}: matches a secret-path pattern")
    return expanded


def _load_lines(fh, path):
    """One JSON value per line, blank lines skipped.

    Claude Code transcripts (~/.claude/projects/*/<session>.jsonl) and most log
    shipping formats are JSONL, which json.load rejects outright at line 2
    ("Extra data"). That single gap is what sent transcript scanning back to
    `python3 -c`, so the error here names the offending line number.
    """
    docs = []
    for lineno, line in enumerate(fh, 1):
        line = line.strip()
        if not line:
            continue
        try:
            docs.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise JsonqError(f"{path}:{lineno}: invalid JSON ({exc.msg})") from None
    return docs


def _load(path, jsonl=False):
    if path == "-":
        return _load_lines(sys.stdin, "<stdin>") if jsonl else json.load(sys.stdin)
    target = _check_readable(path)
    try:
        with open(target, encoding="utf-8") as fh:
            return _load_lines(fh, path) if jsonl else json.load(fh)
    except FileNotFoundError:
        raise JsonqError(f"no such file: {path}") from None
    except json.JSONDecodeError as exc:
        raise JsonqError(f"{path}: invalid JSON ({exc})") from None


def _render(result, raw, indent):
    if raw:
        if isinstance(result, str):
            return result
        if isinstance(result, (list, tuple)):
            return "\n".join(_text(x) for x in result)
    return _dumps(result, indent)


def _install_timeout(seconds):
    """Wall-clock cap. Every loop in this interpreter is a Python-level loop, so
    the handler gets a turn between bytecodes — which is what `while True: pass`
    needs, and what a C-level `2**10**9` would never give it. Hence the
    arithmetic caps at the top: this alarm does not cover them."""
    if not hasattr(signal, "SIGALRM") or seconds <= 0:
        return

    def _fire(_signum, _frame):
        raise JsonqError(f"expression exceeded the {seconds}s timeout")

    signal.signal(signal.SIGALRM, _fire)
    signal.alarm(seconds)
