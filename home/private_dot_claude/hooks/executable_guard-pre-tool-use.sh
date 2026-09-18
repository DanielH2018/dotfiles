#!/usr/bin/env bash
# guard-pre-tool-use.sh — PreToolUse/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# claude-guard deny path): cannot run → this shim emits `ask` ITSELF, without Python. That was
# the posture block-dangerous-bash.sh took on a missing jq, and the rule it encodes survives
# the bash: a deny list that cannot be evaluated must not fail open, and denying every Bash
# call would be indistinguishable from a hang. So a missing uv, a missing managed 3.14, a
# missing package, or a Python process that exits non-zero all print the ask line below and
# exit 0. hook.py owns the other half: an exception INSIDE Python prints the same ask from
# there.
#
# Live, always (spec "Rollout" rows 4 and 6): the Python side's verdict decides -- ask, deny,
# the `--force`→`--force-with-lease` upgrade, or silence, per the failure contract above.
# Slice 4 shipped this shim with a CLAUDE_GUARD_DENY_SHADOW switch that computed the verdict,
# logged it against the deployed block-dangerous-bash.sh and decided nothing; slice 6 deleted
# that bash hook (the sandbox port, #508, had moved its last runner onto this shim) and the
# switch with it, so there is no bash left to compare against and no value here to get wrong.
#
# CLAUDE_GUARD_FAIL_CLOSED=1 (the sandbox sets it; see sandbox/executable_claude-sandbox and
# sandbox/settings.base.json) replaces the ask above with a deny and exit 2. The ask is
# fail-closed on the host, where it stops the call and waits for a human. It is NOT
# fail-closed in the sandbox: that CMD is `claude --dangerously-skip-permissions`, which
# skips an ask, so a container missing uv, the managed 3.14 or the package would run with no
# deny check and nothing would say so. Exit 2 is what closes it -- hooks.md, "Exit code 2
# behavior per event": exit 2 blocks whether or not you print JSON, and even a JSON
# permissionDecision of "allow" cannot override it. The JSON is still printed because
# Claude Code still reads stdout on that path, and the reason also goes to stderr, which is
# exit 2's own documented feedback channel; whichever the harness surfaces, the reason
# survives. Writing to stderr here does not contradict the stderr note below: that discards
# PYTHON's stderr, where a traceback could quote the command text. This reason is a fixed
# string containing no command text.
#
# `--no-project` stops uv reading a pyproject in cwd; `--system` stops it answering with a
# valid, version-matching virtualenv it finds by walking up from cwd instead — measured
# returning such a worktree's own `.venv/bin/python3` in place of the managed interpreter.
# `--managed-python` restricts the answer to a uv-managed install. `-S` skips site-packages;
# the package is stdlib-only. `-P` stops Python prepending cwd (as `''`) to sys.path for `-m`
# — measured `sys.path[:3] == ['', PYTHONPATH-dir, ...]` without it, so a Claude session
# working in a directory that happens to hold its own claude_guard.py (or, unset -S, any
# stdlib-named module) would shadow this package ahead of PYTHONPATH in the very process
# that decides whether to deny a command. Python's stdout is captured rather than passed
# through so a non-zero exit can replace whatever partial output preceded it with the ask
# line. Its stderr is discarded too — an uncaught Python traceback would otherwise reach the
# harness's hook-stderr channel verbatim, and a traceback can quote the command text this
# hook exists to avoid ever printing.
set -u
: "${CLAUDE_GUARD_FAIL_CLOSED:=0}"
ASK='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"claude-guard: the dangerous-command rules could not be evaluated (interpreter or package unavailable). Review this command yourself."}}'
DENY_REASON='claude-guard: the dangerous-command rules could not be evaluated (interpreter or package unavailable). This container fails closed, so the command was blocked without being run.'
fail() {
  if [ "$CLAUDE_GUARD_FAIL_CLOSED" = 1 ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$DENY_REASON"
    printf '%s\n' "$DENY_REASON" >&2
    exit 2
  fi
  printf '%s\n' "$ASK"
  exit 0
}
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || fail
PY=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || fail
[ -x "$PY" ] || fail
OUT=$(PYTHONPATH="$SHARE" "$PY" -S -P -m claude_guard.cli pre-tool-use 2>/dev/null) || fail
[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
