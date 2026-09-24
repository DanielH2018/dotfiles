#!/usr/bin/env python3
# gen-hooks: register
#   event: Stop
#   timeout: 10
#   order: 35
# String checks over text the harness already hands a Stop hook: the final reply, and
# the session transcript. Each rule is a CLAUDE.md sentence that a regex can decide,
# and each blocks at most once, so a false positive costs one turn rather than a loop.
"""Stop hook: block once when the final reply breaks a rule a regex can check.

Each check is a named function over a `Turn` (the final reply plus a lazily parsed view
of the transcript) that returns a reason string or None. Every reason goes out prefixed
with its tag, `[stop-checks:<name>]`, and that tag is also how "once" is decided:

  - a TURN check stays quiet when its tag already appears in a Stop-hook feedback record
    since the operator's last prompt. The same reply is never blocked twice; the next
    turn is judged afresh;
  - a SESSION check stays quiet when its tag appears anywhere in the transcript.

The harness writes a Stop hook's block reason into the transcript as a user record whose
text opens `Stop hook feedback:`, so the transcript already holds the stamp, and this
hook keeps no state file. `stop_hook_active` is deliberately NOT the once-switch:
it is shared by every Stop hook, so a block from check-before-stop.sh would otherwise
switch this hook off for the re-stop that follows.

Every failure path is silent. A Stop hook that cannot read its input has no business
blocking a turn. Opt out with CLAUDE_STOP_CHECKS=0.

Checks:

  artifact-link-last (turn) -- CLAUDE.md "The link is the last thing in your reply".
      The reply contains an artifact link outside a code fence, and its last non-blank
      line does not. link-artifact.sh emits the link and tells the model where to put
      it; this is the half that checks where it went.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

TAG = "[stop-checks:{}]"
FEEDBACK_PREFIX = "Stop hook feedback:"

# Read at most this much of the transcript from the end when walking back to the start
# of the turn. The turn sits at the tail; a whole-file parse would cost seconds on a
# long session for nothing.
TURN_TAIL_BYTES = 2_000_000

# A fence opener or closer: three or more backticks or tildes at the start of a line.
FENCE = re.compile(r"^[ \t]*(?:`{3,}|~{3,})", re.M)


def fence_spans(text: str) -> list[tuple[int, int]]:
    """Character ranges of `text` inside a fenced code block (premature-done.py's rule).

    An unclosed final fence runs to the end of the text, as a Markdown renderer does.
    """
    spans: list[tuple[int, int]] = []
    open_at = None
    for match in FENCE.finditer(text):
        if open_at is None:
            open_at = match.start()
        else:
            spans.append((open_at, match.end()))
            open_at = None
    if open_at is not None:
        spans.append((open_at, len(text)))
    return spans


def outside_fences(text: str) -> str:
    """`text` with every fenced block blanked to spaces; offsets and lines survive."""
    chars = list(text)
    for start, end in fence_spans(text):
        for i in range(start, end):
            if chars[i] != "\n":
                chars[i] = " "
    return "".join(chars)


def _records(lines):
    """Parse JSONL lines into dicts, skipping anything that does not parse."""
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            yield record


def _user_text(record: dict) -> str | None:
    """A user record's text, or None when it is the harness answering a tool call."""
    message = record.get("message")
    if not isinstance(message, dict) or message.get("role") != "user":
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if content and all(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        ):
            return None
        return "\n".join(
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return None


class Turn:
    """The final reply and a lazily read transcript, shared by every check."""

    def __init__(self, payload: dict, env: dict):
        self.payload = payload
        self.env = env
        path = payload.get("transcript_path")
        self.transcript = Path(path).expanduser() if isinstance(path, str) else None
        self._turn_feedback = None
        self._reply = None

    def _tail_records(self) -> list[dict]:
        if not self.transcript or not self.transcript.is_file():
            return []
        with self.transcript.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - TURN_TAIL_BYTES))
            raw = handle.read()
        lines = raw.split(b"\n")
        if size > TURN_TAIL_BYTES and lines:
            lines = lines[1:]  # the first line is half of a record the seek cut through
        return list(_records(lines))

    def _walk_turn(self) -> None:
        """Collect this turn's Stop-hook feedback and assistant text, newest first."""
        feedback: list[str] = []
        texts: list[str] = []
        for record in reversed(self._tail_records()):
            if record.get("isSidechain"):
                continue
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            if message.get("role") == "assistant":
                content = message.get("content")
                if isinstance(content, list):
                    for block in reversed(content):
                        if isinstance(block, dict) and block.get("type") == "text":
                            texts.append(block.get("text", ""))
                continue
            text = _user_text(record)
            if text is None:
                continue
            if text.startswith(FEEDBACK_PREFIX):
                feedback.append(text)
                continue
            break  # the operator's prompt that opened this turn
        self._turn_feedback = feedback
        if self._reply is None:
            self._reply = next((t for t in texts if t.strip()), "")

    @property
    def reply(self) -> str:
        """The final assistant message: the payload's field, else the transcript's."""
        if self._reply is None:
            given = self.payload.get("last_assistant_message")
            if isinstance(given, str) and given.strip():
                self._reply = given
            else:
                self._walk_turn()
        return self._reply or ""

    def fired_this_turn(self, tag: str) -> bool:
        if self._turn_feedback is None:
            self._walk_turn()
        return any(tag in text for text in self._turn_feedback or [])


# ------------------------------------------------------------------ artifact-link-last


def _artifact_url(env: dict) -> re.Pattern[str]:
    """Every form link-artifact.sh emits: file:// into an artifacts dir, the loopback
    server on its configured port, and the cluster route under the base URL."""
    port = re.escape(env.get("CLAUDE_ARTIFACTS_PORT") or "8181")
    forms = [
        r"file://\S*?/(?:\.claude/)?artifacts/\S+",
        rf"https?://127\.0\.0\.1:{port}/\S+",
    ]
    base = (env.get("CLAUDE_ARTIFACTS_BASE_URL") or "").rstrip("/")
    if base:
        forms.append(re.escape(base) + r"/a/\S+")
    return re.compile("|".join(forms))


def artifact_link_last(turn: Turn) -> str | None:
    reply = turn.reply
    if not reply.strip():
        return None
    url = _artifact_url(turn.env)
    visible = outside_fences(reply)
    found = url.search(visible)
    if not found:
        return None
    last = next((ln for ln in reversed(reply.splitlines()) if ln.strip()), "")
    if url.search(last):
        return None
    return (
        f"Your reply links an artifact ({found.group(0).rstrip(').,>')}) but does not "
        "end on that link. The rule is that the link is the last line of the reply, "
        "with nothing after it -- after the **Takeaway** block, when there is one, not "
        "instead of it. Do not repeat the reply: send one short message whose last "
        "line is the link."
    )


# Order is the order reasons appear in a block that carries more than one.
CHECKS = [
    ("artifact-link-last", "turn", artifact_link_last),
]


def evaluate(payload: dict, env: dict) -> str | None:
    """The block reason for this Stop, or None to let it stand."""
    turn = Turn(payload, env)
    reasons = []
    for name, scope, check in CHECKS:
        tag = TAG.format(name)
        try:
            reason = check(turn)
            if reason is None:
                continue
            if scope == "turn" and turn.fired_this_turn(tag):
                continue
        except (OSError, ValueError):
            continue
        reasons.append(f"{tag} {reason}")
    if not reasons:
        return None
    return "\n\n".join(reasons) + (
        "\n\nEach check above blocks once; if it misread the reply, stop again."
    )


def main() -> int:
    if os.environ.get("CLAUDE_STOP_CHECKS") == "0":
        return 0
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    reason = evaluate(payload, dict(os.environ))
    if reason:
        json.dump({"decision": "block", "reason": reason}, sys.stdout)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
