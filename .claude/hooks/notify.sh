#!/bin/bash
# Notification hook: send a desktop notification when Claude needs attention.
# Works on macOS (osascript) and Linux (notify-send).

set -u

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude Code"')
TITLE=$(echo "$INPUT" | jq -r '.title // "Claude Code"')

if command -v osascript >/dev/null 2>&1; then
  # macOS
  osascript -e "display notification \"${MESSAGE//\"/\\\"}\" with title \"${TITLE//\"/\\\"}\" sound name \"Glass\""
elif command -v notify-send >/dev/null 2>&1; then
  # Linux (requires libnotify-bin)
  notify-send "$TITLE" "$MESSAGE"
fi

exit 0
