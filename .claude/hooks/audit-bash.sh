#!/bin/bash
# PreToolUse hook for Bash: append an audit line per command to ~/.claude/bash-audit.log.
# Runs silently; does not block anything.
# Rotates when log exceeds ~5000 lines, keeping the most recent 3000.

set -u

LOG_FILE="${HOME}/.claude/bash-audit.log"
MAX_LINES=5000
KEEP_LINES=3000
mkdir -p "$(dirname "$LOG_FILE")"

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION=$(echo "$INPUT" | jq -r '.session_id // "?"')
CWD=$(echo "$INPUT" | jq -r '.cwd // "?"')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Single-line JSON per entry so you can grep and jq the log.
jq -cn \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION" \
  --arg cwd "$CWD" \
  --arg cmd "$COMMAND" \
  '{ts: $ts, session: $session, cwd: $cwd, command: $cmd}' \
  >> "$LOG_FILE"

# Rotate: if over MAX_LINES, keep only the most recent KEEP_LINES.
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  tail -n "$KEEP_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

exit 0
