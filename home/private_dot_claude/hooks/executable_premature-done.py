#!/usr/bin/env python3
# gen-hooks: register
#   event: Stop
#   timeout: 10
#   order: 30
# `claude agents` files a session under "Completed" when the CLI's own regex
# chain reads a `result:` line in the last 800 characters of the turn text -- a
# marker that short-circuits every later branch, so a session writing one while
# a deploy is still outstanding drops off the operator's queue. This blocks that
# turn when the same window also says the work is unfinished, and asks for the
# `result:` + `next:` pair that reaches the working state instead. Background
# jobs only. The hook's own docstring carries which three steps of the chain are
# ported and why the rest are not.
"""Stop hook: block a background job from filing itself Completed while its own
text says the work is not finished.

`claude agents` groups a session by the `state` field in
~/.claude/jobs/<id>/state.json, and "Completed" is `state: "done"`. Nothing
configurable sets that field. It is derived by a regex chain compiled into the CLI
(`o_t` in the 2.1.258 bundle) that reads the LAST 800 CHARACTERS of the turn's
concatenated assistant text and returns one of done / working / blocked / failed. A
`result:` line in that window is the first thing it matches and it short-circuits
everything after, so a session that writes one while a deploy is still outstanding
files itself Completed and drops off the operator's queue.

That is the measured failure. Of the 9 `done` transitions carrying assistant text in
this machine's ~/.claude/jobs/*/timeline.jsonl on 2026-09-02, every one was the
`result-marker` branch, and three said the work was unfinished in the same sentence as
the marker:

    result: Homepage's search box switched from Google to Kagi (PR #824, merged);
    deploy blocked behind another session's broad `initial_setup.yml` change in
    PR #823.

    result: Built PR #823 - a daily systemd timer running the `/renovate-prs` skill
    unattended on daniel-box, shipping disarmed; left unmerged because it touches
    `initial_setup.yml`, a broad-manual path.

WHY THE SIGNAL IS THE MESSAGE, NOT GIT. The obvious check - "does this branch have an
open PR, or is it ahead of origin/HEAD" - goes silent on both cases above, because
both PRs were merged. What was outstanding was the deploy, and no git predicate sees a
deploy. The message contradicting itself is the thing both cases actually have in
common, so that is what this reads: a `result:` marker plus a phrase in the same
window saying the work is not finished.

WHY ONLY PART OF THE CLASSIFIER IS PORTED. `o_t` has twenty-two branches and three of
the late ones also return done (`pushed-committed` on a message whose last sentence
starts "Opened PR #N", `ready-for` on "Ready to land", `verdict-marker` on
"VERDICT: PASS"). Reproducing those faithfully means porting every branch that
precedes them, because any earlier match wins. The three steps ported here - find the
last `result:` line, look for a blocked/failed marker after it, look for a `next:`
line after it - are the FIRST three, so nothing can preempt them and the partial port
is exact rather than a guess. The three late branches appeared in none of the
measured transitions; they are left out deliberately.

THE REPAIR IS AN APPENDED PAIR OF LINES, NOT A REWRITE. The classifier reads the
turn's concatenated text and takes the LAST `result:` match, so a replacement message
that simply drops the marker leaves the original one still in the window, still
winning, still done. The only escape is the `result-then-next` branch: a `next:` line
AFTER a `result:` line yields working/idle. The block text therefore asks for both
lines to be restated together, which is deterministic whatever the window has shifted
to.

SCOPE. Background jobs only, keyed on CLAUDE_JOB_DIR - those are the sessions
`claude agents` lists. A foreground session is not in that list and its operator is
reading the reply anyway, so a block there would be pure interruption.

Every failure path is silent: no payload, no transcript, an unreadable file, a record
that does not parse. A Stop hook that cannot read its input has no business blocking a
turn.

Opt out with CLAUDE_PREMATURE_DONE_CHECK=0.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from pathlib import Path

# The classifier's own window. Everything below is measured against the last 800
# characters of the turn text, because that is all `o_t` ever sees.
TAIL_CHARS = 800

# Read at most this much of the transcript from the end. A turn's assistant text sits
# at the tail; a whole-file parse would cost seconds on a long session for nothing.
TRANSCRIPT_TAIL_BYTES = 2_000_000

# Ported verbatim from the bundle, with JS's /gi becoming re.I and Python's implicit
# global matching. The one deliberate difference: JS's `$` means end-of-input while
# Python's also matches before a final newline, which can only make the last line
# match where JS would not - a difference that cannot manufacture a `result:` line
# that is not there.
RESULT_LINE = re.compile(r"(?:^|\n)\s*result:\s*(.+?)\s*(?:\n|$)", re.I)
NEXT_LINE = re.compile(r"(?:^|\n)\s*next:\s*\S", re.I)

# The blocked/failed markers `o_t` checks in the region after the result line. Any of
# them means the CLI does NOT return done, so this hook has nothing to correct.
AFTER_RESULT_MARKERS = [
    re.compile(r"(?:^|\n)\s*failed\s*[:—–-]\s*(?:.{3,200}?)(?=\n|$)", re.I),
    re.compile(r"(?:^|\n)\s*needs input\s*[:—–-]\s*(?:.{3,200}?)(?=\n|$)", re.I),
    re.compile(r"(?:^|\n)\s*blocked\s*[:—–-]\s*(?:.{3,200}?)(?=\n|$)", re.I),
    re.compile(r"\bI'?m blocked\s*[:—–-]\s*(?:.{3,200}?)(?=\n|$)", re.I),
]

# Phrases that contradict a completion claim. Each is named so its test can state both
# halves - one tail it must flag and one it must leave alone - and so a block can say
# which phrase it saw. This is a lower bound on the ways a session can admit unfinished
# work, not a closed set: a miss stays silent, which is the right direction.
#
# They do fire on a session DESCRIBING the failure rather than committing it - a reply
# about undeployed work reads the same as an undeployed reply. That was measured, not
# predicted: replaying these rules over the 9 transitions flagged 3, one of which was a
# finished session whose result line used the words "not deployed" about someone else.
# The cost is one extra turn, once per distinct ending, and the alternative - reading
# intent rather than words - is the LLM classifier this exists to correct.
UNFINISHED = [
    (
        "deploy-blocked",
        re.compile(
            r"\b(?:deploy(?:ment)?s?\s+(?:is\s+|are\s+|was\s+)?blocked"
            r"|blocks?\s+(?:the\s+)?deploy(?:ment)?s?)\b",
            re.I,
        ),
    ),
    ("blocked-behind", re.compile(r"\bblocked\s+(?:on|by|behind)\b", re.I)),
    (
        "left-undone",
        re.compile(
            r"\b(?:left|remains?|still|not)\s+"
            r"(?:un)?(?:merged|deployed|landed|applied|verified)\b",
            re.I,
        ),
    ),
    (
        "not-yet",
        re.compile(
            r"\bnot\s+yet\s+(?:merged|deployed|landed|applied|verified|run)\b", re.I
        ),
    ),
    ("waiting-on", re.compile(r"\b(?:waiting|awaiting)\s+(?:on|for)\b", re.I)),
    (
        "pending",
        re.compile(
            r"\bpending\s+(?:deploy(?:ment)?|CI|merge|review|verification"
            r"|checks?|rollout)\b",
            re.I,
        ),
    ),
    (
        "unfinished-adjective",
        re.compile(r"\b(?:unverified|undeployed|unlanded|unmerged)\b", re.I),
    ),
]

# A fence opener or closer: three or more backticks or tildes at the start of a line.
FENCE = re.compile(r"^[ \t]*(?:`{3,}|~{3,})", re.M)


def fence_spans(text: str) -> list[tuple[int, int]]:
    """Character ranges of `text` that sit inside a fenced code block.

    `o_t` ignores a marker inside a fence, so this hook must too - a session quoting
    someone else's `result:` line in a code block is not claiming completion. Openers
    and closers alternate; an unclosed final fence runs to the end of the text, which
    is what a Markdown renderer does with one.
    """
    spans: list[tuple[int, int]] = []
    open_at: int | None = None
    for match in FENCE.finditer(text):
        if open_at is None:
            open_at = match.start()
        else:
            spans.append((open_at, match.end()))
            open_at = None
    if open_at is not None:
        spans.append((open_at, len(text)))
    return spans


def in_fence(spans: list[tuple[int, int]], index: int) -> bool:
    """Whether `index` falls inside any of `spans`."""
    return any(start <= index < end for start, end in spans)


def turn_text(transcript: Path) -> str:
    """The assistant text of the last turn, joined the way the classifier sees it.

    Walks the transcript backwards collecting assistant text blocks and stops at the
    genuine user message that opened the turn - a `tool_result` record is the harness
    replying to a tool call, not the operator, so it does not end the turn. Sidechain
    records belong to subagents and never reach the classifier.
    """
    with transcript.open("rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
        raw = handle.read()
    lines = raw.split(b"\n")
    if size > TRANSCRIPT_TAIL_BYTES and lines:
        lines = lines[1:]  # the first line is half of a record the seek cut through

    chunks: list[str] = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("isSidechain"):
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "assistant" and isinstance(content, list):
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text":
                    chunks.append(block.get("text", ""))
        elif role == "user":
            # A list whose blocks are all tool results is the harness, not the
            # operator, so it does not end the turn.
            if isinstance(content, list) and all(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            ):
                continue
            break
    return "\n\n".join(text for text in reversed(chunks) if text.strip())


def classifies_done(tail: str) -> re.Match[str] | None:
    """The last `result:` match in `tail` when `o_t` returns done for it, else None.

    Steps 1-3 of the chain, in the bundle's order: the last non-fenced `result:` line
    wins; a blocked or failed marker after it takes precedence and yields
    blocked/failed; a `next:` line after it yields the `result-then-next` branch,
    which is working.
    """
    spans = fence_spans(tail)
    result = None
    for match in RESULT_LINE.finditer(tail):
        if not in_fence(spans, match.start()):
            result = match
    if result is None:
        return None

    rest = tail[result.end() :]
    offset = result.end()
    for marker in AFTER_RESULT_MARKERS:
        for match in marker.finditer(rest):
            if not in_fence(spans, offset + match.start()):
                return None
    for match in NEXT_LINE.finditer(rest):
        if not in_fence(spans, offset + match.start()):
            return None
    return result


def contradiction(tail: str) -> str | None:
    """The name of the first phrase in `tail` that says the work is not finished."""
    for name, pattern in UNFINISHED:
        if pattern.search(tail):
            return name
    return None


def already_nudged(job_dir: Path, tail: str) -> bool:
    """Whether this exact ending has already been blocked once.

    Keyed on the tail's hash rather than on the session, because the state that
    matters is the session's LAST turn: a nudge spent on turn 3 must not buy silence
    for a turn 9 that regresses. The same ending never re-blocks, a different one
    does.
    """
    stamp = job_dir / "premature-done-nudged"
    digest = hashlib.sha256(tail.encode("utf-8")).hexdigest()
    try:
        seen = stamp.read_text(encoding="utf-8").split()
    except OSError:
        seen = []
    if digest in seen:
        return True
    try:
        with stamp.open("a", encoding="utf-8") as handle:
            handle.write(digest + "\n")
    except OSError:
        pass
    return False


REASON = (
    'This turn will be filed under "Completed" in `claude agents`, and its own text '
    "says the work is not finished ({phrase}). The job state comes from a regex over "
    "the last 800 characters of your turn text: a `result:` line means done, full "
    "stop.\n"
    "If the work IS finished, stop again - this will not fire twice on the same "
    "ending.\n"
    "If it is not, end your next message with exactly these two lines, in this "
    "order:\n"
    "  result: <the one-line outcome, restated>\n"
    "  next: <what still has to happen, and who does it>\n"
    "Restate both - do not just delete the marker. The classifier takes the LAST "
    "`result:` match in the window, so the one you already wrote keeps winning unless "
    "a `next:` line follows a later one.\n"
    "Use `needs input: <what you need>` instead if what remains is a decision only "
    "the operator can make; that files the session under Blocked and pings them."
)


def main() -> int:
    """Read the Stop payload and block when the turn files a false completion."""
    if os.environ.get("CLAUDE_PREMATURE_DONE_CHECK") == "0":
        return 0

    job_dir = os.environ.get("CLAUDE_JOB_DIR")
    if not job_dir:
        return 0  # foreground session: not in the `claude agents` listing
    job_path = Path(job_dir)
    if not job_path.is_dir():
        return 0

    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if payload.get("stop_hook_active"):
        return 0  # already blocked once in this cascade

    transcript = payload.get("transcript_path")
    if not transcript:
        return 0
    path = Path(transcript).expanduser()
    if not path.is_file():
        return 0

    try:
        text = turn_text(path)
    except OSError:
        return 0
    tail = text[-TAIL_CHARS:]
    if not tail.strip():
        return 0

    if classifies_done(tail) is None:
        return 0
    phrase = contradiction(tail)
    if phrase is None:
        return 0
    if already_nudged(job_path, tail):
        return 0

    json.dump({"decision": "block", "reason": REASON.format(phrase=phrase)}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
