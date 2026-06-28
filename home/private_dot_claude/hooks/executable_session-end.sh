#!/bin/bash
# SessionEnd hook: log session summary and check for unsaved work.
# Fires when a session terminates. Output is informational only (not shown to Claude).

set -u

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

# Log session end timestamp
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=end" >> "$LOG_DIR/sessions.log"

# If in a git repo, warn about uncommitted changes left behind
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

  if [ "$DIRTY" -gt 0 ] || [ "$STAGED" -gt 0 ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=dirty_exit branch=$BRANCH dirty=$DIRTY staged=$STAGED" >> "$LOG_DIR/sessions.log"
  fi
fi

exit 0
