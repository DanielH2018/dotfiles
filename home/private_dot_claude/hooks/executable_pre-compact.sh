#!/bin/bash
# PreCompact hook: fires on auto-compact only (not manual /compact).
# Injects git state so Claude can reorient after compaction.

set -u

MSG="Auto-compact proceeding."

# Inject current git state so it survives compaction
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | head -10)
  RECENT=$(git log -3 --pretty=format:'  %h %s' 2>/dev/null)

  MSG="$MSG

Post-compact git context (branch: $BRANCH):
Recent commits:
$RECENT"

  if [ -n "$DIRTY" ]; then
    MSG="$MSG

Uncommitted changes:
$DIRTY"
  fi
fi

MSG="$MSG

If this session contains important decisions or feedback, use the remember skill to preserve them."

jq -n --arg msg "$MSG" '{
  "continue": true,
  "systemMessage": $msg
}'
