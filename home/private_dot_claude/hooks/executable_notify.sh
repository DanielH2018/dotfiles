#!/bin/bash
# Notification hook: alert -- audibly and visually -- when Claude needs attention.
# Works on macOS (osascript), WSL, and desktop Linux (notify-send + play-sound.sh).

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# idle_prompt reaches this hook only for a BACKGROUND JOB, never for a session you are sitting
# in. The distinction matters because the two cases are opposite: a job raising "waiting for
# your input" is the one asking you a question and has no pane of its own to show it, while a
# foreground session raises the same type 60s after every finished turn, and chiming on that
# trains you to ignore the cue that matters. That is why idle_prompt was excluded outright.
#
# Excluding it outright was too blunt: a background job's turn-end raises idle_prompt from the
# JOB's own session, and agent_needs_input from the supervisor only intermittently -- so the
# job case went silent. Measured 2026-08-20: session 664f7ae8 (a job) raised idle_prompt at
# 13:32:42 with no agent_needs_input anywhere near it.
#
# A job owns $HOME/.claude/jobs/<first 8 chars of its session id>; a foreground session owns no
# such directory. That is the whole test.
if [ "$(hook_field '.notification_type // ""')" = "idle_prompt" ]; then
  SID=$(hook_field '.session_id // ""')
  if [ -z "$SID" ] || [ ! -d "$HOME/.claude/jobs/${SID%%-*}" ]; then
    exit 0
  fi
fi

MESSAGE=$(hook_field '.message // "Claude Code"')
TITLE=$(hook_field '.title // "Claude Code"')

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
else
  # Desktop Linux. notify-send draws a banner but is silent: KDE and GNOME only
  # attach a sound to notifications from a registered application, and notify-send
  # is not one. Play the cue out-of-band so the audible alert never depends on the
  # notification daemon's per-app sound settings.
  "$HOME/.claude/hooks/play-sound.sh" input
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$TITLE" "$MESSAGE"
  fi
fi

exit 0
