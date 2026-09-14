#!/usr/bin/env bash
# PostToolUse on Edit|Write|NotebookEdit: the first real edit of a session claims
# the branch's Planka card — resolve or create it, move it to In Progress, and
# stamp the session's identifiers on it.
#
# First edit only. Without the marker this would make an HTTP call per edit. The
# marker also encodes the policy the spec chose: a session that only reads and
# answers questions never touches the board, because it never gets here.
#
# Everything is backgrounded and every path exits 0. A board that is down, slow,
# or simply not running must never add latency to an edit, and must never fail one.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

# shellcheck source=./hook-input.sh
. "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"
hook_read_input
SESSION_ID="$(hook_field '.session_id')"
[ -n "$SESSION_ID" ] || exit 0

STATE_DIR="${PLANKA_STATE_DIR:-$HOME/.claude/planka}"
MARKER_DIR="$STATE_DIR/claimed"
mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
MARKER="$MARKER_DIR/$SESSION_ID"

# noclobber makes "create the marker" the atomic claim, so two edits racing in
# the same session still produce exactly one claim.
if ! (set -o noclobber; : > "$MARKER") 2>/dev/null; then
  exit 0
fi

planka card resolve --create >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
