"""Waits: run `cc-wait` the way its result can reach the session, and refuse hand-written waits.

Every wait a session makes goes through `cc-wait` (docs/specs/2026-10-04-cc-wait-design.md).
This module is that spec's harness binding: the one rule deciding how a wait runs, so no
skill, brief or prompt has to carry the decision.

THE REWRITE. A Bash call that runs `cc-wait`:

  * in a session a task notification can wake, gets `run_in_background: true` and a 30-minute
    Bash timeout. When `cc-wait` is the command's last stage it also gets `--budget 1740`, so a
    landing of up to 29 minutes wakes the session once rather than every 570s. A call the
    caller already backgrounded gets the same timeout and budget;
  * in a session that cannot be woken -- a headless `claude -p` agent, or a subagent, whose turn
    ends for good -- stays in the foreground with `timeout: 600000`. The 120s default would cut
    off cc-wait's own 570s budget.

The rewrite carries every other key of the tool input. Claude Code replaces the input with
`updatedInput` rather than merging it (server #3501, dotfiles #771), and a key left out is a key
lost. It carries no permissionDecision, so it changes the call without approving it.

WHO CAN BE WOKEN, measured on 2026-10-04 (Claude Code 2.1.289) with a scratch PreToolUse hook:

  * a subagent's call carries `agent_id` (and `agent_type`); the main agent's call carries
    neither;
  * a hook that sets `run_in_background: true` is honoured: the call returned "Command running
    in background with ID: b0kjmt8p0".

A session is a `claude` process. One started with `--print` ends with its turn, unless
`--input-format stream-json` feeds it later turns, which is how bridge and remote-control
sessions run. The ancestry walk uses `ps`, which macOS has and `/proc` it does not. When the
walk finds no `claude` ancestor the call stays in the foreground: a blocked call costs time,
and a lost notification costs the result.

THE DENY. A hand-written wait in the foreground is denied, naming what replaces it: `sleep` of
10s or more, an until/while loop around `sleep`, `tail -f`, `gh run watch`, `gh pr checks
--watch` and `kubectl ... --watch`. Backgrounded, the same command is a wait the harness
already tracks, so it passes.
"""

import re
import shlex
import subprocess
from collections.abc import Callable, Mapping
from pathlib import PurePath

from claude_guard.deny import Verdict
from claude_guard.segment import parse

FOREGROUND_TIMEOUT_MS = 600_000
BACKGROUND_TIMEOUT_MS = 1_800_000
# Under BACKGROUND_TIMEOUT_MS, so cc-wait ends on its own budget before the harness kills it.
BACKGROUND_BUDGET_S = 1740
SLEEP_THRESHOLD_S = 10
MAX_ANCESTRY = 40

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_POLL_LOOPS = frozenset({"until", "while"})
_LOOPS = _POLL_LOOPS | {"for", "select"}
_DURATION = re.compile(r"^(\d+(?:\.\d+)?)([smhd]?)$")
_UNIT_S = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}

Ps = Callable[[int], tuple[int, str] | None]


def _argv(text: str) -> list[str]:
    try:
        return shlex.split(text)
    except ValueError:
        return []


def _command_words(argv: list[str]) -> list[str]:
    """`argv` from its program on: leading `VAR=value` assignments dropped."""
    i = 0
    while i < len(argv) and _ASSIGNMENT.match(argv[i]):
        i += 1
    return argv[i:]


def _stages(command: str) -> list[list[str]]:
    """Each stage's words from its program on; empty when the command cannot be read."""
    parsed = parse(command)
    if not parsed.ok:
        return []
    return [words for seg in parsed.segments if (words := _command_words(_argv(seg.text)))]


def _program(words: list[str]) -> str:
    return PurePath(words[0]).name if words else ""


# `cc-wait --list` and `--help` print and exit at once; only a named source waits.
_NOT_A_WAIT = frozenset({"--list", "--help", "-h"})


def _is_wait(words: list[str]) -> bool:
    return _program(words) == "cc-wait" and len(words) > 1 and words[1] not in _NOT_A_WAIT


# --- the rewrite -------------------------------------------------------------------------------


def _ps(pid: int) -> tuple[int, str] | None:
    """(parent pid, command line) for `pid`, or None when `ps` cannot say."""
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=,args=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return None
    line = out.stdout.strip()
    if out.returncode != 0 or not line:
        return None
    ppid, _, args = line.partition(" ")
    try:
        return int(ppid), args.strip()
    except ValueError:
        return None


def _is_claude(argv: list[str]) -> bool:
    if not argv:
        return False
    if PurePath(argv[0]).name == "claude" or "/claude/versions/" in argv[0]:
        return True
    # An npm install runs as `node .../@anthropic-ai/claude-code/cli.js`.
    return PurePath(argv[0]).name == "node" and any("claude-code" in a for a in argv[1:2])


def claude_argv(start_pid: int, ps: Ps = _ps) -> list[str] | None:
    """The command line of the nearest `claude` process at or above `start_pid`, or None."""
    pid = start_pid
    for _ in range(MAX_ANCESTRY):
        found = ps(pid)
        if found is None:
            return None
        ppid, args = found
        argv = args.split()
        if _is_claude(argv):
            return argv
        if ppid <= 1 or ppid == pid:
            return None
        pid = ppid
    return None


def _flag_value(argv: list[str], flag: str) -> str | None:
    for i, word in enumerate(argv):
        if word == flag and i + 1 < len(argv):
            return argv[i + 1]
        if word.startswith(flag + "="):
            return word.partition("=")[2]
    return None


def wakeable(payload: Mapping, start_pid: int, ps: Ps = _ps) -> bool:
    """Whether a task notification can reach the session that made this call."""
    if payload.get("agent_id"):
        return False
    argv = claude_argv(start_pid, ps)
    if argv is None:
        return False
    if "--print" not in argv and "-p" not in argv:
        return True
    return _flag_value(argv, "--input-format") == "stream-json"


def rewrite(payload: Mapping, start_pid: int, ps: Ps = _ps) -> dict | None:
    """The `updatedInput` for a Bash call that runs `cc-wait`, or None to leave the call alone.

    A call the caller already backgrounded gets the same budget and timeout as one this
    backgrounds: left at the 570s default, it woke the session every 570s (dotfiles #781). A
    foreground call whose own timeout already covers cc-wait's budget is left alone.
    """
    if payload.get("tool_name") != "Bash":
        return None
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    stages = _stages(command)
    if not any(_is_wait(words) for words in stages):
        return None
    if tool_input.get("run_in_background") or wakeable(payload, start_pid, ps):
        timeout = tool_input.get("timeout")
        updated = {
            **tool_input,
            "run_in_background": True,
            "timeout": max(timeout if isinstance(timeout, int) else 0, BACKGROUND_TIMEOUT_MS),
        }
        # cc-wait reads --budget wherever it appears, so appending it reaches the last stage.
        if _is_wait(stages[-1]) and "--budget" not in stages[-1]:
            updated["command"] = f"{command.rstrip()} --budget {BACKGROUND_BUDGET_S}"
        return updated if updated != tool_input else None
    if (
        isinstance(tool_input.get("timeout"), int)
        and tool_input["timeout"] >= FOREGROUND_TIMEOUT_MS
    ):
        return None
    return {**tool_input, "timeout": FOREGROUND_TIMEOUT_MS}


# --- the deny ----------------------------------------------------------------------------------

_BACKGROUND_IT = "or run it with `run_in_background: true` so its task notification wakes you"

LOOP_REASON = (
    "Blocked: an until/while loop around `sleep` is a hand-written poll. Wait with "
    "`cc-wait <source>` instead (`cc-wait --list` names them; a repo adds one under "
    ".claude/wait-sources/), " + _BACKGROUND_IT + "."
)
SLEEP_REASON = (
    "Blocked: a foreground `sleep` of 10s or more is a hand-written wait. Wait on the thing "
    "itself with `cc-wait <source>` (`cc-wait --list`), " + _BACKGROUND_IT + "."
)
TAIL_REASON = (
    "Blocked: `tail -f` in the foreground is a hand-written wait. Wait for the line with "
    "`cc-wait file <log> --match '<line>' --fail '<failure line>'`."
)
WATCH_REASON = (
    "Blocked: `{what}` in the foreground holds the call until the checks end. Wait with "
    "`cc-wait gh-ci <sha>` or `cc-wait gh-ci --pr <n>`, which ends on the first failed check, "
    "and `cc-wait gh-pr <n>` for the merge."
)
KUBECTL_REASON = (
    "Blocked: `kubectl ... --watch` never exits on its own. Wait on a rollout or a Job with "
    "`cc-wait k8s-rollout <kind>/<name> -n <namespace>`, which also fails at once on a new pod "
    "that cannot run; or stream the watch under a Monitor."
)


def _seconds(word: str) -> float | None:
    match = _DURATION.match(word)
    return float(match.group(1)) * _UNIT_S[match.group(2)] if match else None


def _unwrap_timeout(words: list[str]) -> list[str]:
    """The command `timeout [opts] DURATION cmd...` runs, or `words` when it is not one."""
    if _program(words) != "timeout":
        return words
    rest = words[1:]
    while rest and rest[0].startswith("-"):
        # `-s KILL` and `-k 5` take a value; `--signal=KILL` and `--foreground` do not.
        takes_value = rest[0] in ("-s", "-k", "--signal", "--kill-after")
        rest = rest[2:] if takes_value else rest[1:]
    return rest[1:] if rest else []


def _stage_verdict(words: list[str]) -> Verdict | None:
    words = _unwrap_timeout(words)
    program, args = _program(words), words[1:]
    if program == "sleep":
        total = sum(s for a in args if (s := _seconds(a)) is not None)
        if total >= SLEEP_THRESHOLD_S:
            return Verdict("deny", "hand-wait-sleep", SLEEP_REASON)
    elif program == "tail":
        if any(a in ("-f", "-F", "--follow") or a.startswith("--follow=") for a in args) or any(
            re.fullmatch(r"-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*", a) for a in args
        ):
            return Verdict("deny", "hand-wait-tail", TAIL_REASON)
    elif program == "gh" and args[:2] == ["run", "watch"]:
        return Verdict("deny", "hand-wait-gh", WATCH_REASON.format(what="gh run watch"))
    elif program == "gh" and args[:2] == ["pr", "checks"] and "--watch" in args:
        return Verdict("deny", "hand-wait-gh", WATCH_REASON.format(what="gh pr checks --watch"))
    elif program == "kubectl" and any(
        a in ("-w", "--watch", "--watch-only") or a.startswith("--watch=") for a in args
    ):
        return Verdict("deny", "hand-wait-kubectl", KUBECTL_REASON)
    return None


def _loop_around_sleep(stages: list[list[str]]) -> bool:
    """Whether a `sleep` runs inside an `until` or `while` loop's body.

    Read from the parsed stages, not the command text: a loop quoted inside an argument (a
    `git grep -e 'until …; do sleep'` pattern) or written into a heredoc body is not a loop,
    and a regex over the raw text denied both. The parser splits a real loop into
    `until …` / `do sleep 5` / `done` stages. `for` and `select` count only for nesting, so
    the `done` of a `for` inside a `while` does not end the `while`.
    """
    open_loops: list[str] = []
    for words in stages:
        if words[0] in _LOOPS:
            open_loops.append(words[0])
        elif words[0] == "done":
            if open_loops:
                open_loops.pop()
        elif _POLL_LOOPS & set(open_loops):
            body = words[1:] if words[0] == "do" else words
            if _program(body) == "sleep":
                return True
    return False


def hand_wait(command: str, background: bool) -> Verdict | None:
    """A deny for a hand-written wait run in the foreground, or None."""
    if background:
        return None
    stages = _stages(command)
    if _loop_around_sleep(stages):
        return Verdict("deny", "hand-wait-loop", LOOP_REASON)
    for words in stages:
        verdict = _stage_verdict(words)
        if verdict:
            return verdict
    return None
