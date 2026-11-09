#!/usr/bin/env bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Read
#   timeout: 5
#   order: 52
#   description: Nudge a whole-file Read of a large file toward offset and limit
# read-nudge.sh — PreToolUse/Read shim for claude-guard's whole-file-read nudge (dotfiles #1085).
#
# A Read with no offset or limit of a file over 20 KB gets a once-per-session
# additionalContext line pointing at `rg -n` and a bounded Read. The rule lives in
# claude_guard.nudges.read_nudge, beside the Bash nudges whose tag and once-per-session marker it
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
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/lib/claude-guard-call.sh" 2>/dev/null \
  || skip "cannot load claude-guard-call.sh"
if ! claude_guard_call read-nudge "${CLAUDE_GUARD_TIMEOUT_S:-2}" 65536; then
  [[ "$CG_FAIL" = absent ]] && exit 0
  skip "$CG_FAIL"
fi
[[ -z "$RB_OUT" ]] || printf '%s\n' "$RB_OUT"
exit 0
