#!/usr/bin/env bash
# Record Claude Code session state for the WezTerm Agent-View TUI (wezview).
# Keyed by session id (stable), caching the last-known WEZTERM_PANE since some
# hook events on Windows fire without it. JSON is built with jq so Windows paths
# (backslashes) are escaped correctly. Emits NOTHING on stdout.
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
if [ -z "$pane" ] && [ -f "$file" ]; then                 # keep last-known pane
  pane=$(jq -r '.pane // ""' "$file" 2>/dev/null)
fi
ts=$(date +%s 2>/dev/null || echo 0)
host=$(hostname 2>/dev/null)
# MSYS_NO_PATHCONV: on Windows a native jq.exe lets Git-Bash rewrite a leading-slash
# --arg (a POSIX cwd like /home/ubuntu) into a drive path before jq sees it; disable
# it (no-op on Linux, where this same hook also runs). Write via temp + mv so a
# concurrent hook event on the same session can never observe a half-written file.
tmp="$file.tmp.$$"
if MSYS_NO_PATHCONV=1 jq -nc --arg pane "$pane" --arg state "$state" --arg cwd "$cwd" \
       --arg session "$sid" --arg host "$host" --argjson ts "${ts:-0}" \
       '{pane:$pane,state:$state,cwd:$cwd,session:$session,host:$host,ts:$ts}' \
       > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
  rm -f "$tmp" 2>/dev/null
fi
exit 0
