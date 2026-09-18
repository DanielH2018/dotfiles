#!/usr/bin/env bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: TodoWrite
#   timeout: 10
#   order: 80
# PostToolUse on TodoWrite: mirror the session's todo list into the card's Plan
# task list. The CLI reads the hook payload on stdin and does the reconciling.
#
# Backgrounded and always exit 0, for the same reason as planka-claim.sh: a board
# that is down must not slow down or fail the tool call that triggered this.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
printf '%s' "$INPUT" | planka plan sync >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
