#!/usr/bin/env bash
# guard-pre-tool-use.sh — PreToolUse/Bash shim for the claude-guard package.
#
# Failure contract (spec docs/specs/2026-09-06-claude-guard-design.md, "Failure contracts",
# claude-guard deny path): cannot run → this shim emits `ask` ITSELF, without Python. That is
# the posture block-dangerous-bash.sh takes on a missing jq (see its own header comment: it is
# unregistered here as of slice 4, but the file itself is NOT deleted -- the sandbox still
# runs it): a deny list that cannot be evaluated must not fail open, and denying every Bash
# call would be indistinguishable from a hang. So a missing uv, a missing managed 3.14, a
# missing package, or a Python process that exits non-zero all print the ask line below and
# exit 0. hook.py owns the other half: an exception INSIDE Python in live mode prints the same
# ask from there.
#
# Live (spec "Rollout" row 4, slice 4): with CLAUDE_GUARD_DENY_SHADOW=0 the Python side's
# verdict decides -- ask, deny, or the `--force`→`--force-with-lease` upgrade, or silence, per
# the failure contract above. Any other value (shadow, the pre-slice-4 default) computes the
# verdict, logs it to ~/.claude/logs/claude-guard-deny-shadow.jsonl against the deployed
# block-dangerous-bash.sh, and decides nothing -- but nothing on this host sets that value any
# more, since the bash is no longer registered here to run a comparison against. settings.base.json
# sets the variable in its env block and flipped to "0" in the same commit that flipped the
# default below from :=1 to :=0. Both must agree: if the generated settings.json ever lost this
# key (a stale regeneration, a host-conditional template branch that never sets it), the OLD
# default of :=1 would leave the hook permanently in shadow with no host-side comparison ever
# reaching it -- the deny check stops firing and nothing reports it.
# DECIDED: the shim's default now matches the template's post-cutover value for exactly this
# reason; a missing key fails toward the live decision the cutover made, not toward a shadow
# mode that nothing on this host runs a comparison for any more.
#
# This is a SEPARATE switch from CLAUDE_GUARD_SHADOW (the PermissionRequest side): the two
# sides cut over independently, and slice 4 shipped after slice 3.
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
: "${CLAUDE_GUARD_DENY_SHADOW:=0}"
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
OUT=$(PYTHONPATH="$SHARE" "$PY" -S -P -m claude_guard.cli pre-tool-use 2>/dev/null) || fail
[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
