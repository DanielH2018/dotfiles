#!/bin/bash
# PostToolUse hook (catch-all): audit every tool invocation to /audit/.
# /audit/ is bind-mounted from the host at ~/.claude/sandbox/audit/<repo-name>/.

set -u

LOG_DIR="${LOG_DIR:-/audit}"
mkdir -p "$LOG_DIR" 2>/dev/null || true
LOG_FILE="$LOG_DIR/$(date -u +%Y-%m-%d).jsonl"
MAX_LINES=5000
KEEP_LINES=3000

INPUT=$(cat)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION=$(echo "$INPUT" | jq -r '.session_id // "?"')
TOOL=$(echo "$INPUT" | jq -r '.tool_name // "?"')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

jq -cn \
  --arg ts "$TIMESTAMP" \
  --arg session "$SESSION" \
  --arg tool "$TOOL" \
  --arg file "$FILE_PATH" \
  --arg cmd "$COMMAND" \
  '{ts: $ts, session: $session, tool: $tool, file: (if $file != "" then $file else null end), cmd: (if $cmd != "" then $cmd else null end)}' \
  >> "$LOG_FILE"

LINE_COUNT=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  tail -n "$KEEP_LINES" "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
fi

exit 0
