#!/bin/bash
# PostToolUse hook (catch-all): append an audit line per tool invocation.
# Complements audit-bash.sh — this captures Read, Edit, Write, WebFetch, Agent, etc.
# Runs silently; does not block anything.
# Rotates when log exceeds ~5000 lines, keeping the most recent 3000.

set -u

LOG_FILE="${HOME}/.claude/tool-audit.log"
MAX_LINES=5000
KEEP_LINES=3000
mkdir -p "$(dirname "$LOG_FILE")"

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION=$(echo "$INPUT" | jq -r '.session_id // "?"')
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "?"')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Build a compact JSONL entry.
jq -cn \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION" \
  --arg tool "$TOOL" \
  --arg file "$FILE_PATH" \
  --arg cmd "$COMMAND" \
  '{ts: $ts, session: $session, tool: $tool, file: (if $file != "" then $file else null end), cmd: (if $cmd != "" then $cmd else null end)}' \
  >> "$LOG_FILE"

# Rotate: if over MAX_LINES, keep only the most recent KEEP_LINES.
LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  tail -n "$KEEP_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

exit 0
