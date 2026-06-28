#!/bin/bash
# StopFailure hook: log API errors and notify on rate limits.
# Fires when a turn ends due to an API error rather than normal completion.

set -u

INPUT=$(cat)
ERROR_TYPE=$(echo "$INPUT" | jq -r '.error_type // "unknown"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=stop_failure error_type=$ERROR_TYPE" >> "$LOG_DIR/sessions.log"

# Desktop notification for rate limits so the user knows to wait
case "$ERROR_TYPE" in
  rate_limit|overloaded)
    if command -v osascript >/dev/null 2>&1; then
      osascript -e 'on run argv
        display notification (item 1 of argv) with title "Claude Code" sound name "Submarine"
      end run' -- "Rate limited — try again in a few minutes" &
    fi
    ;;
esac

exit 0
