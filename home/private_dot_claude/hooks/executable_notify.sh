#!/bin/bash
# Notification hook: send a desktop notification when Claude needs attention.
# Works on macOS (osascript) and Linux (notify-send).

set -u

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | jq -r '.message // "Claude Code"')
TITLE=$(echo "$INPUT" | jq -r '.title // "Claude Code"')

if command -v osascript >/dev/null 2>&1; then
  # macOS — play the sound directly so the audible cue never depends on
  # Notification Center delivery (osascript banners are attributed to Script
  # Editor and are silently dropped if it lacks notification permission).
  afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 &
  # Banner is best-effort; no `sound name` here to avoid a double chime once
  # Script Editor notification permission is granted.
  # argv passing avoids shell injection via message content.
  osascript -e 'on run argv
    display notification (item 2 of argv) with title (item 1 of argv)
  end run' -- "$TITLE" "$MESSAGE"
elif grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  # WSL — notify-send has no daemon here, so play an audible Windows cue instead.
  "$HOME/.claude/hooks/play-sound.sh" input
elif command -v notify-send >/dev/null 2>&1; then
  # Linux (requires libnotify-bin)
  notify-send "$TITLE" "$MESSAGE"
fi

exit 0
