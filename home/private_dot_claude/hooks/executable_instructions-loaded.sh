#!/bin/bash
# InstructionsLoaded hook: log which CLAUDE.md and rule files are active.
# Helps debug path-scoped rules and monorepo instruction loading.

set -u

INPUT=$(cat)
LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

# This event fires once per loaded instruction file, carrying a singular
# `file_path` (not a `files` array — reading `.files[]` logged nothing).
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID instructions_loaded: $FILE_PATH" >> "$LOG_DIR/sessions.log"

exit 0
