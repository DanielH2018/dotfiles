#!/usr/bin/env bash
# Record HOST Claude Code session state for the Agent View picker (agentview).
# Keyed by session id (stable). Captures the pane's backend/locator once so the
# picker can focus it directly; caches the last-known pane/locator/title since some
# hook events on Windows fire without WEZTERM_PANE. Delegates the atomic write to the
# shared register helper. Emits NOTHING on stdout.
# Usage: agent-view-state.sh <working|needs-input|completed|idle|end>
state="${1:-idle}"
source "$HOME/.claude/hooks/agent-view-register.sh"
dir=$(av_dir)
input=$(cat 2>/dev/null)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$sid" ] && sid="nosession"
file="$dir/$sid.json"

# Host rows key on the stable session id (no RUN_ID), so the delete is unconditional.
if [ "$state" = "end" ]; then av_guarded_remove "$sid"; exit 0; fi

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
pane="${WEZTERM_PANE:-}"
locator=$(av_capture_locator)
title=""
if [ -f "$file" ]; then                                   # carry last-known fields forward
  [ -z "$pane" ] && pane=$(jq -r '.pane // ""' < "$file" 2>/dev/null)
  case "$locator" in none:|none|'') locator=$(jq -r '.locator // ""' < "$file" 2>/dev/null);; esac
  title=$(jq -r '.title // ""' < "$file" 2>/dev/null)
fi
ts=$(date +%s 2>/dev/null || echo 0)
host=$(hostname 2>/dev/null)
av_write_full "$sid" "$state" "$cwd" "$host" "$ts" "host" "$title" "$locator" "$pane" ""
exit 0
