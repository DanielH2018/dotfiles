#!/bin/bash
# DIAGNOSTIC (temporary): append every Notification payload to a log, so a spurious audible
# cue can be traced to the notification_type that produced it. notify.sh is gated on
# permission_prompt and that gate is real, so a cue arriving when nothing is blocked has a
# source we have not identified. Delete this hook and its settings.base.json entry once the
# log has caught one.
set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

LOG="$HOME/.claude/logs/notify-debug.jsonl"
mkdir -p "${LOG%/*}"

# Cap the log rather than let a chatty notification type fill the disk unattended.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 500 "$LOG" > "$LOG.trim" 2>/dev/null && mv "$LOG.trim" "$LOG"
fi

# tojson keeps it to one line: hook_field runs `jq -r`, which would otherwise pretty-print
# a bare object across several lines and break the jsonl.
line=$(hook_field '{ts: (now | todate), type: (.notification_type // "?"), sid: (.session_id // "?"), title: (.title // ""), msg: (.message // "")} | tojson')
[ -n "$line" ] && printf '%s\n' "$line" >> "$LOG"
exit 0
