#!/usr/bin/env bash
# Record Claude Code session state for the WezTerm Agent-View TUI (wezview).
# Keyed by session id (stable), caching the last-known WEZTERM_PANE since some
# hook events may fire without it. JSON is built with jq so paths are escaped
# correctly. Emits NOTHING on stdout.
# Usage: wezterm-state.sh <working|needs-input|completed|idle|end>
state="${1:-idle}"
dir="$HOME/.claude/wez-state"
mkdir -p "$dir" 2>/dev/null
input=$(cat 2>/dev/null)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$sid" ] && sid="nosession"
file="$dir/$sid.json"
if [ "$state" = "end" ]; then rm -f "$file" 2>/dev/null; exit 0; fi
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
pane="${WEZTERM_PANE:-}"
if [ -z "$pane" ] && [ -f "$file" ]; then
  pane=$(jq -r '.pane // ""' "$file" 2>/dev/null)
fi
ts=$(date +%s 2>/dev/null || echo 0)
host=$(hostname 2>/dev/null)
jq -nc --arg pane "$pane" --arg state "$state" --arg cwd "$cwd" \
       --arg session "$sid" --arg host "$host" --argjson ts "${ts:-0}" \
       '{pane:$pane,state:$state,cwd:$cwd,session:$session,host:$host,ts:$ts}' \
       > "$file" 2>/dev/null
exit 0
