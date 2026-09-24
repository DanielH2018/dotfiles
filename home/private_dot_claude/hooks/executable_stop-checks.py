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

  preamble (turn) -- daniel-voice.md "No preamble". The reply's first line opens with
      a whole stock phrase ("Great question", "Sure!", "You're right"). A sentence that
      only contains one of those words does not match.

  evidence-for-claims (turn) -- CLAUDE.md "evidence before claims". The reply says the
      tests pass or the linter is clean, outside a fence and not marked unverified, and
      no Bash command in the session looks like a test or lint run.
      premature-done.py covers only the `result:` marker.

  tests-for-source (session) -- CLAUDE.md "Write tests for any new code". The session
      created a source file (a Write whose result was "create") outside scratch space
      and edited no file on a test path. "Needs a test" is judgement; "no test file at
      all" is not.

  migration (session) -- rules/sql.md. The session wrote a file under migrations/,
      migration/ or db/migrate/, and either the file names no down step or
      reversibility (an .up.sql needs its .down.sql sibling), or no `migration-reviewer`
      agent was dispatched.
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
        self._session = None

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

    def session(self) -> Session:
        """The whole transcript's tool calls, parsed once for every session check."""
        if self._session is None:
            self._session = Session(self.transcript)
        return self._session


# The substrings a record must hold to be worth a json.loads in the session scan. A
# 12 MB transcript is mostly tool results; skipping them unparsed is what keeps the scan
# inside the hook's timeout.
_SESSION_NEEDLES = (b'"tool_use"', b'"type":"create"', FEEDBACK_PREFIX.encode())


class Session:
    """Every tool call the main session made, read from the whole transcript."""

    def __init__(self, transcript: Path | None):
        self.edited: list[str] = []  # file paths passed to Edit/Write/NotebookEdit
        self.created: set[str] = set()  # paths whose Write result was "create"
        self.bash: list[str] = []  # Bash commands
        self.agents: set[str] = set()  # subagent_type of every Agent/Task call
        self.feedback: list[str] = []  # every Stop-hook feedback text
        if not transcript or not transcript.is_file():
            return
        with transcript.open("rb") as handle:
            lines = [ln for ln in handle if any(n in ln for n in _SESSION_NEEDLES)]
        for record in _records(lines):
            if record.get("isSidechain"):
                continue
            result = record.get("toolUseResult")
            if isinstance(result, dict) and result.get("type") == "create":
                path = result.get("filePath")
                if isinstance(path, str):
                    self.created.add(path)
            text = _user_text(record)
            if text is not None and text.startswith(FEEDBACK_PREFIX):
                self.feedback.append(text)
            message = record.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            content = message.get("content")
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    self._tool(block.get("name"), block.get("input"))

    def _tool(self, name, data) -> None:
        if not isinstance(data, dict):
            return
        if name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            path = data.get("file_path") or data.get("notebook_path")
            if isinstance(path, str):
                self.edited.append(path)
        elif name == "Bash" and isinstance(data.get("command"), str):
            self.bash.append(data["command"])
        elif name in ("Agent", "Task") and isinstance(data.get("subagent_type"), str):
            self.agents.add(data["subagent_type"])

    def fired(self, tag: str) -> bool:
        return any(tag in text for text in self.feedback)


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


# ------------------------------------------------------------------ preamble

# Openers that only delay the answer. Each is a whole phrase at the very start of the
# reply, so a sentence that merely contains "sure" or "great" never matches.
PREAMBLE = re.compile(
    r"^\W*(?:"
    r"(?:great|good|excellent|interesting) question"
    r"|(?:sure|certainly|absolutely|of course|okay|ok|alright|got it|understood)"
    r"(?:\s+thing)?\s*[,.!:]"
    r"|you'?re (?:absolutely |completely )?right\b"
    r"|i'?d be (?:happy|glad) to\b"
    r"|happy to help\b"
    r"|great[,.!]"
    r")",
    re.I,
)


def preamble(turn: Turn) -> str | None:
    first = next((ln for ln in turn.reply.splitlines() if ln.strip()), "")
    found = PREAMBLE.match(first)
    if not found:
        return None
    return (
        f'Your reply opens with a preamble ("{found.group(0).strip()}"). The voice '
        "rule is to lead with the outcome. Send the reply again without the opener, "
        "starting from what happened or what you found."
    )


# ------------------------------------------------------------------ evidence-for-claims

# A claim, and the Bash commands that count as having run the thing claimed. The
# command patterns are a lower bound on test and lint runners: a claim backed by a
# runner not listed here blocks once, and stopping again clears it.
CLAIMS = [
    (
        "tests pass",
        re.compile(
            r"\b(?:all\s+)?(?:the\s+)?(?:unit\s+)?tests?\s+(?:now\s+|all\s+|still\s+)?"
            r"(?:pass(?:es|ed)?|are\s+(?:passing|green)|(?:is|are)\s+green)\b"
            r"|\btest\s+suite\s+(?:passes|passed|is\s+green)\b",
            re.I,
        ),
        re.compile(
            r"\b(?:test|tests|pytest|jest|vitest|mocha|bats|tox|nox|prek|pre-commit"
            r"|ctest|rspec|phpunit)\b|\b(?:go|cargo|mvn|gradle)\s+test\b|make\s+check",
            re.I,
        ),
    ),
    (
        "the linter is clean",
        re.compile(
            r"\b(?:the\s+)?(?:linter|lint|linting|lints)\s+(?:is\s+|are\s+|comes?\s+back\s+)?"
            r"(?:clean|passes|passed|green)\b|\blint[- ]clean\b",
            re.I,
        ),
        re.compile(
            r"lint|ruff|eslint|oxlint|shellcheck|prek|pre-commit|flake8|mypy|pyright"
            r"|\btsc\b|clippy|biome|shfmt|hadolint|yamllint",
            re.I,
        ),
    ),
]

UNVERIFIED = re.compile(r"\bunverified\b|\bnot (?:yet )?(?:run|verified)\b", re.I)


def evidence_for_claims(turn: Turn) -> str | None:
    visible = outside_fences(turn.reply)
    missing = []
    for label, claim, runner in CLAIMS:
        lines = [ln for ln in visible.splitlines() if claim.search(ln)]
        if not lines or all(UNVERIFIED.search(ln) for ln in lines):
            continue
        if any(runner.search(cmd) for cmd in turn.session().bash):
            continue
        missing.append(label)
    if not missing:
        return None
    return (
        f"Your reply says {' and '.join(missing)}, and this session ran no Bash "
        "command that looks like that run. Evidence comes before claims: run the "
        "command and quote its output, or say the status is unverified. If the run "
        "happened somewhere this hook cannot see (a subagent, another session), say "
        "so and stop again."
    )


# ------------------------------------------------------------------ tests-for-source

SOURCE_EXT = re.compile(
    r"\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|rb|sh|bash|php|swift|c|cc|cpp|h)$"
)
TEST_PATH = re.compile(
    r"(?:^|/)(?:tests?|__tests__|spec|specs|testdata)/"
    r"|(?:^|/)test_[^/]*$|_test\.[^/]+$|\.(?:test|spec)\.[^/]+$|_spec\.[^/]+$"
    r"|(?:^|/)conftest\.py$"
)


def _is_scratch(path: str, env: dict) -> bool:
    home = (env.get("HOME") or "").rstrip("/")
    if path.startswith(("/tmp/", "/var/tmp/", "/private/tmp/")):
        return True
    return bool(home) and path.startswith(home + "/.claude/")


def tests_for_source(turn: Turn) -> str | None:
    session = turn.session()
    added = sorted(
        p
        for p in session.created
        if SOURCE_EXT.search(p)
        and not TEST_PATH.search(p)
        and not _is_scratch(p, turn.env)
    )
    if not added:
        return None
    if any(TEST_PATH.search(p) for p in session.edited):
        return None
    shown = ", ".join(added[:5]) + (" ..." if len(added) > 5 else "")
    return (
        f"This session added source files ({shown}) and touched no test file. "
        "CLAUDE.md asks for tests for new code, in the project's existing framework. "
        "Write them, or tell the user why these files need none. This fires once "
        "per session."
    )


# ------------------------------------------------------------------ migration

MIGRATION_PATH = re.compile(
    r"/(?:migrations?|db/migrate)/[^/]+\.(?:sql|py|rb|js|ts|go)$"
)
REVERSIBLE = re.compile(
    r"\b(?:down|downgrade|rollback|revert|reversible|irreversible)\b|\bdef change\b",
    re.I,
)


def _lacks_down(path: str) -> bool:
    file = Path(path)
    if path.endswith(".up.sql"):
        return not file.with_name(file.name[: -len(".up.sql")] + ".down.sql").exists()
    try:
        text = file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False  # deleted or unreadable since: nothing left to judge
    return not REVERSIBLE.search(text)


def migration(turn: Turn) -> str | None:
    session = turn.session()
    touched = sorted({p for p in session.edited if MIGRATION_PATH.search(p)})
    touched = [p for p in touched if Path(p).exists()]
    if not touched:
        return None
    problems = []
    no_down = [p for p in touched if _lacks_down(p)]
    if no_down:
        problems.append(
            "these have no down migration and do not say whether they are reversible: "
            + ", ".join(no_down)
        )
    if "migration-reviewer" not in session.agents:
        problems.append("the `migration-reviewer` agent has not run this session")
    if not problems:
        return None
    return (
        "This session wrote database migrations, and rules/sql.md asks that every "
        "migration be reversible and reviewed before merge. "
        + "; ".join(problems)
        + ". Add the down step (or the header line saying why it cannot have one), "
        "and dispatch `migration-reviewer` before the PR merges. This fires once per "
        "session."
    )


# Order is the order reasons appear in a block that carries more than one.
CHECKS = [
    ("artifact-link-last", "turn", artifact_link_last),
    ("preamble", "turn", preamble),
    ("evidence-for-claims", "turn", evidence_for_claims),
    ("tests-for-source", "session", tests_for_source),
    ("migration", "session", migration),
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
            if scope == "session" and turn.session().fired(tag):
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
