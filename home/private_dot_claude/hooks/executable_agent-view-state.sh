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
# Name the row from the session's own transcript when we have no title yet. On tmux/Ghostty
# there's no wezterm pane title for the picker to correlate, so without this a host row shows
# only its folder — indistinguishable when several sessions share a directory. The latest
# custom-title (the name shown in Claude Code) wins; fall back to the agent name. Skipped
# once a title exists, so a picker CTRL+R rename isn't overwritten on the next event.
if [ -z "$title" ]; then
  tpath=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -z "$tpath" ]; then
    # No path in the input: find it by session id. A transcript is <sid>.jsonl under some
    # ~/.claude/projects/<cwd-slug>/ dir; globbing by sid is drift-proof (the cwd, and thus
    # the slug, can change mid-session) where rebuilding the slug from the current cwd isn't.
    tpath=$(ls -t "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
  fi
  if [ -f "$tpath" ]; then
    line=$(grep -a '"type":"custom-title"' "$tpath" 2>/dev/null | tail -1)
    [ -z "$line" ] && line=$(grep -a '"type":"agent-name"' "$tpath" 2>/dev/null | tail -1)
    [ -n "$line" ] && title=$(printf '%s' "$line" | jq -r '.customTitle // .agentName // ""' 2>/dev/null)
  fi
fi
ts=$(date +%s 2>/dev/null || echo 0)
host=$(hostname 2>/dev/null)
av_write_full "$sid" "$state" "$cwd" "$host" "$ts" "host" "$title" "$locator" "$pane" ""
exit 0
