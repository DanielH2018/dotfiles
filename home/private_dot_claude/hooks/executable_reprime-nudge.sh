#!/bin/bash
# PostToolUse (matcher "*"): a periodic "reprime" nudge for long tool-heavy
# stretches. The rules loaded at context start scroll out of view over a long
# autonomous run; once every N tool calls this re-surfaces a POINTER to the
# authoritative sources (never a copy of them — the reprime skill re-reads the
# live files on purpose, so a baked-in copy would just go stale). Fast, and
# silent below the threshold.
#
# Count is one atomic append per call, so the byte-count stays correct even
# when several tool calls in one turn fire concurrent hook processes; the only
# unsynchronised write is the "last nudged at" marker, where a race at worst
# costs a harmless duplicate nudge. No lock — this runs after every tool.
#
# Tuning: CLAUDE_REPRIME_EVERY (tool calls between nudges, default 30; 0 = off).

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
SID=$(hook_field '.session_id // empty')
[ -z "$SID" ] && SID="nosession"

EVERY="${CLAUDE_REPRIME_EVERY:-30}"
case "$EVERY" in ''|*[!0-9]*) EVERY=30 ;; esac
[ "$EVERY" -lt 1 ] && exit 0

STATE_DIR="$HOME/.claude/logs/reprime-state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
COUNTF="$STATE_DIR/$SID.count"
LASTF="$STATE_DIR/$SID.last"

# One atomic append per tool call; byte count = tool calls this session.
printf '.' >> "$COUNTF" 2>/dev/null || exit 0
COUNT=$(wc -c < "$COUNTF" 2>/dev/null | tr -d ' ')
case "$COUNT" in ''|*[!0-9]*) exit 0 ;; esac

LAST=$(cat "$LASTF" 2>/dev/null || echo 0)
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac

# Not enough new activity since the last nudge -> stay silent.
[ $((COUNT - LAST)) -lt "$EVERY" ] && exit 0

echo "$COUNT" > "$LASTF" 2>/dev/null
# Opportunistic prune of stale per-session files (only on the rare nudge path).
find "$STATE_DIR" -type f -mtime +1 -delete 2>/dev/null

jq -n --arg every "$EVERY" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("REPRIME NUDGE (automated, ~every " + $every + " tool calls): a long tool-heavy stretch has buried the rules loaded at context start. Re-read your authoritative sources now — ~/.claude/CLAUDE.md and its @-includes, the project CLAUDE.md / CLAUDE.local.md, and any relevant ~/.claude/rules/*.md — then self-audit the highest-decay directives: be terse, keep diffs minimal, and verify before asserting (never claim anything about code or output you have not reread this session). If you have drifted, fix it in the reply you are writing. Realign silently; do not narrate this nudge.")
  }
}'
exit 0
