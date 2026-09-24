#!/usr/bin/env bash
# gen-hooks: register
#   event: Stop
#   timeout: 10
#   order: 20
# One session-log comment on the Planka card, and only for a session that
# claimed one — the claim marker is the evidence that this session edited
# something, so a read-only session leaves no trace on the board.
# Stop: one session-log comment on the branch's card.
#
# The card stays in In Progress. A session that ends without landing has not
# stopped being in progress, and Blocked is never written automatically — a card
# is blocked because the operator says so, and nothing observable here
# distinguishes blocked from paused. Stale work shows as a card whose last
# comment is old.
#
# Only comments when this session actually claimed a card: the claim marker is
# the evidence that this session edited something, so a read-only session stays
# off the board entirely.

set -uo pipefail

[ "${PLANKA_TRACKING:-}" = "0" ] && exit 0
command -v planka >/dev/null 2>&1 || exit 0

# shellcheck source=./hook-input.sh
. "$(dirname "${BASH_SOURCE[0]}")/hook-input.sh"
hook_read_input
# `// empty`: jq -r prints `null` for a missing key, which is non-empty (same fix as claim).
SESSION_ID="$(hook_field '.session_id // empty')"
[ -n "$SESSION_ID" ] || exit 0

STATE_DIR="${PLANKA_STATE_DIR:-$HOME/.claude/planka}"
[ -f "$STATE_DIR/claimed/$SESSION_ID" ] || exit 0

# A prose summary is the skill's job, written to this file during the session.
SUMMARY_FILE="$STATE_DIR/summary/$SESSION_ID"

# The planka-tracking skill says to write it before stopping; this makes that a
# block, once per session. The block reason carries SUMMARY_TAG, and the harness
# records a Stop hook's reason in the transcript, so a transcript already holding the
# tag means this session was asked once. No transcript to read means no way to keep
# it to once, so the hook does not block and the fallback below posts instead. The
# blocking pass posts nothing: the next Stop posts, so the card gets one comment.
SUMMARY_TAG='[planka-stop:summary]'
if [ ! -s "$SUMMARY_FILE" ]; then
  TRANSCRIPT="$(hook_field '.transcript_path // empty')"
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && ! grep -qF -- "$SUMMARY_TAG" "$TRANSCRIPT"; then
    jq -n --arg tag "$SUMMARY_TAG" --arg file "$SUMMARY_FILE" '{
      decision: "block",
      reason: ("\($tag) This session claimed a Planka card and has written no session-log summary. Write \($file) with three things, in this order: what changed, what was verified and with which command, what is next. Then stop again; the Stop hook posts it as the card comment. This asks once per session.")
    }'
    exit 0
  fi
fi

# Absent a summary, say something true and cheap rather than inventing detail.
if [ -s "$SUMMARY_FILE" ]; then
  TEXT="$(cat "$SUMMARY_FILE")"
else
  BRANCH="$(git branch --show-current 2>/dev/null || true)"
  HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
  TEXT="Session paused on ${BRANCH:-an unknown branch} at ${HEAD_SHA:-an unknown commit}."
fi

printf '%s' "$TEXT" | planka card comment >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
