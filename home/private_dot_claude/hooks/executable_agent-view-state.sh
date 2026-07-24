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

# git_review_marker CWD -> echo a short "not-done" marker if the repo is dirty or has
# unpushed commits, else nothing. Used to split a genuinely-finished stop from one that
# left work behind: the turn ends (state "completed") but the tree isn't committed/pushed.
git_review_marker() {
  local cwd="$1" mark="" ahead
  command -v git >/dev/null 2>&1 || return 0
  git -C "$cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ -n "$(git -C "$cwd" status --porcelain 2>/dev/null)" ] && mark="⚠ dirty"
  ahead=$(git -C "$cwd" rev-list --count '@{upstream}..HEAD' 2>/dev/null)
  case "$ahead" in ''|*[!0-9]*) ahead=0;; esac
  [ "$ahead" -gt 0 ] 2>/dev/null && mark="${mark:+$mark }↑$ahead"
  printf '%s' "$mark"
}
input=$(cat 2>/dev/null)
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$sid" ] && sid="nosession"
file="$dir/$sid.json"

# Host rows key on the stable session id (no RUN_ID), so the delete is unconditional.
if [ "$state" = "end" ]; then av_guarded_remove "$sid"; exit 0; fi

# Headless sdk invocations (`claude -p` — e.g. the remember plugin's haiku
# summarizers) fire the same hooks as real sessions but have no pane or prompt to
# attend to: skip them so they never register as phantom rows. Claude's own
# per-process registry marks them entrypoint "sdk-cli"; real interactive/bg
# sessions carry "cli". No registry file (older claude) -> register as before.
if [ -n "${CLAUDE_PID:-}" ]; then
  case "$(jq -r '.entrypoint // ""' "$HOME/.claude/sessions/${CLAUDE_PID}.json" 2>/dev/null)" in
    sdk*) exit 0;;
  esac
fi

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
[ -z "$cwd" ] && cwd="$PWD"
pane="${WEZTERM_PANE:-}"
locator=$(av_capture_locator)
title=""
# CLAUDE_PID = this session's process; recorded so the picker can prune a leaked local row
# whose process has since died (a session killed without firing the SessionEnd `end` hook).
pid="${CLAUDE_PID:-}"
if [ -f "$file" ]; then                                   # carry last-known fields forward
  [ -z "$pane" ] && pane=$(jq -r '.pane // ""' < "$file" 2>/dev/null)
  case "$locator" in none:|none|'') locator=$(jq -r '.locator // ""' < "$file" 2>/dev/null);; esac
  title=$(jq -r '.title // ""' < "$file" 2>/dev/null)
  [ -z "$pid" ] && pid=$(jq -r '.pid // ""' < "$file" 2>/dev/null)
fi
# Name the row with Claude's OWN session title from the transcript, using the same precedence
# Claude's UI does: a user-set `custom-title` (via /rename — including agentview's CTRL+R,
# which sends /rename into the pane) WINS over the auto `ai-title`. grep each type first
# (cheap even on a multi-MB JSONL), then jq only those and take the latest. Falls back to the
# carried title (a sandbox repo·branch, or empty -> the picker shows the age).
tpath=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ -n "$tpath" ] && [ -f "$tpath" ]; then
  ct=$(grep -aF '"custom-title"' "$tpath" 2>/dev/null | jq -r 'select(.type=="custom-title") | .customTitle // empty' 2>/dev/null | tail -1)
  if [ -n "$ct" ]; then title="$ct"
  else
    at=$(grep -aF '"ai-title"' "$tpath" 2>/dev/null | jq -r 'select(.type=="ai-title") | .aiTitle // empty' 2>/dev/null | tail -1)
    [ -n "$at" ] && title="$at"
  fi
fi
ts=$(date +%s 2>/dev/null || echo 0)
host=$(hostname 2>/dev/null)
# A stop with an uncommitted/unpushed tree isn't truly done: keep the marker AND downgrade
# "completed" to "review" so the picker groups it apart. Only completed is downgraded — a
# working/needs-input turn stays as-is (and clears any prior marker). The marker is also
# stored for local sessions whose render state is recomputed from the live registry (idle ->
# completed), where the picker re-derives review from this field.
gitmark=""
if [ "$state" = "completed" ]; then
  gitmark=$(git_review_marker "$cwd")
  [ -n "$gitmark" ] && state="review"
fi
av_write_full "$sid" "$state" "$cwd" "$host" "$ts" "host" "$title" "$locator" "$pane" "" "$pid" "$gitmark"
exit 0
