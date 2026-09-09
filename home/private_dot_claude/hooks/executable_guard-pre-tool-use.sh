#!/usr/bin/env bash
# guard-pre-tool-use.sh — PreToolUse/Bash shim for the claude-guard deny rules (deny.py, the
# port of block-dangerous-bash.sh).
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# claude-guard deny path): cannot run → this shim emits `ask` ITSELF, without Python. That is
# the posture block-dangerous-bash.sh takes on a missing jq (its :20): a deny list that cannot
# be evaluated must not fail open, and denying every Bash call would be indistinguishable from
# a hang. So a missing uv, a missing managed 3.14, a missing package, or a Python process that
# exits non-zero all print the ask line below and exit 0. hook.py owns the other half: an
# exception INSIDE Python in live mode prints the same ask from there.
#
# Shadow (spec "Rollout" row 4): with CLAUDE_GUARD_DENY_SHADOW=1 the Python side computes its
# verdict, runs the deployed block-dangerous-bash.sh on the same stdin, appends one hashed
# line to ~/.claude/logs/claude-guard-deny-shadow.jsonl and prints nothing. In shadow this
# shim prints nothing on failure either — shadow decides nothing, whatever happens.
# settings.base.json sets the variable in its env block; the default below is the belt to
# that brace, so a settings.json not yet regenerated cannot run this hook live. The cutover
# flips both in one PR and removes block-dangerous-bash.sh from the registration.
#
# This is a SEPARATE switch from CLAUDE_GUARD_SHADOW (the PermissionRequest side): the two
# sides cut over independently, and slice 4 ships before slice 3.
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
# line.
set -u
: "${CLAUDE_GUARD_DENY_SHADOW:=1}"
export CLAUDE_GUARD_DENY_SHADOW
ASK='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"claude-guard: the dangerous-command rules could not be evaluated (interpreter or package unavailable). Review this command yourself."}}'
fail() {
  [ "$CLAUDE_GUARD_DENY_SHADOW" = 0 ] && printf '%s\n' "$ASK"
  exit 0
}
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[ -f "$SHARE/claude_guard/cli.py" ] || fail
PY=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || fail
[ -x "$PY" ] || fail
OUT=$(PYTHONPATH="$SHARE" "$PY" -S -P -m claude_guard.cli pre-tool-use) || fail
[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
