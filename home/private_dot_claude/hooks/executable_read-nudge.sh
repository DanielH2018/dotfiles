#!/usr/bin/env bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Read
#   timeout: 5
#   order: 52
# read-nudge.sh — PreToolUse/Read shim for claude-guard's whole-file-read nudge (dotfiles #1085).
#
# A Read with no offset or limit of a file over 20 KB gets a once-per-session
# additionalContext line pointing at `rg -n` and a bounded Read. The rule lives in
# claude_guard.nudges.read_nudge, beside the Bash nudges whose tag and transcript lookup it
# shares; claude-guard's Bash shim never sees a Read, hence this second entry.
#
# Failure contract: this hook decides nothing, so whatever cannot run prints nothing on
# stdout and exits 0, and the Read goes ahead without the nudge. The reason goes to stderr,
# which the harness shows only in verbose mode. Python's own stderr is discarded, as in
# guard-pre-tool-use.sh. The interpreter lookup and the judge both run bounded, inside the
# 5s registration timeout.
set -u
skip() {
  printf 'read-nudge: %s -- no nudge\n' "$1" >&2
  exit 0
}
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/lib/hook-input.sh}" 2>/dev/null \
  || skip "cannot load hook-input.sh"
hook_read_input
SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
[[ -f "$SHARE/claude_guard/cli.py" ]] || exit 0
# shellcheck source=/dev/null
. "${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/lib/run-bounded.sh}" 2>/dev/null \
  || skip "cannot load run-bounded.sh"
command -v run_bounded >/dev/null 2>&1 || skip "run_bounded is not defined"
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/lib/guard-python.sh" 2>/dev/null || skip "cannot load guard-python.sh"
T_FIND=${CLAUDE_GUARD_TIMEOUT_S:-2}
T_JUDGE=${CLAUDE_GUARD_TIMEOUT_S:-2}

guard_python "$T_FIND" || skip "no interpreter (${GUARD_PY_STATUS:-unknown})"
PY=$GUARD_PY

# shellcheck disable=SC2016  # $1/$2 belong to the inner bash
run_bounded "$T_JUDGE" 65536 -- \
  bash -c 'PYTHONPATH="$1" exec "$2" -S -P -m claude_guard.cli read-nudge 2>/dev/null' _ "$SHARE" "$PY" \
  < <(printf '%s' "$_HOOK_INPUT_RAW")
[[ "$RB_STATUS" = ok ]] || skip "claude_guard did not finish within ${T_JUDGE}s ($RB_STATUS)"
[[ "$RB_EXIT" -eq 0 ]] || skip "claude_guard failed (exit $RB_EXIT)"
[[ -z "$RB_OUT" ]] || printf '%s\n' "$RB_OUT"
exit 0
