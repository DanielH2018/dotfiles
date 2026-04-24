#!/bin/bash
# PreToolUse hook for Bash: append an audit line per command to ~/.claude/bash-audit.log.
# Runs silently; does not block anything.

set -u

LOG_FILE="${HOME}/.claude/bash-audit.log"
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

exit 0
