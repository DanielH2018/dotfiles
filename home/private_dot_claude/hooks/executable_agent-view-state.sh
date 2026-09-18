#!/usr/bin/env bash
# gen-hooks: library
#   reason: called by agent-view-subagents.sh; registered nowhere since agentview was deleted (0e6bded)
# Record HOST Claude Code session state for the Agent View picker (agentview).
# Keyed by session id (stable). Captures the pane's backend/locator once so the
# picker can focus it directly; caches the last-known pane/locator/title since some
# hook events on Windows fire without WEZTERM_PANE. Delegates the atomic write to the
# shared register helper. Emits NOTHING on stdout.
# Usage: agent-view-state.sh <start|working|needs-input|completed|idle|end>
state="${1:-idle}"
# shellcheck disable=SC1091  # deployed sibling; source name differs in the chezmoi tree
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
# shellcheck source=/dev/null
source "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
sid=$(hook_field '.session_id // empty')
[ -z "$sid" ] && sid="nosession"
file="$dir/$sid.json"

# Host rows key on the stable session id (no RUN_ID), so the delete is unconditional.
if [ "$state" = "end" ]; then
  av_guarded_remove "$sid"
  rm -f "$dir-subagents/$sid" 2>/dev/null   # the row is gone; its outstanding set can't outlive it
  exit 0
fi

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

# SessionStart registration. Every other event fires only AFTER the user does something, so a
# session started (or resumed) and then left idle never wrote a row at all and was invisible to
# the picker — not reaped, never registered. This closes that hole.
# Deliberately stricter about the sdk filter than the events above: they run once real activity
# has proven the session is interactive, this one runs before any, so an ABSENT registry file is
# "don't know yet" and we skip rather than risk an sdk row. Skipping costs nothing — a session
# that goes on to do anything is registered moments later by UserPromptSubmit or Stop.
# A daemon session (kind "bg") is skipped here for the same reason: the daemon keeps a pool of
# PRE-WARMED spares — claimed processes with a real session id that run this hook and then wait
# for a job that may never come. They have no job, no transcript, and `claude agents` never lists
# them, so registering one renders a nameless idle row CTRL+X cannot clear: removing it only makes
# the daemon warm a replacement, which lands right back here under a new id. A bg session that is
# really running proves it by prompting, and registers from UserPromptSubmit moments later.
if [ "$state" = "start" ]; then
  case "$(jq -r '(.entrypoint // "") + ":" + (.kind // "")' "$HOME/.claude/sessions/${CLAUDE_PID:-}.json" 2>/dev/null)" in
    cli:bg) exit 0;;
    cli:*)  state="idle";;
    *)      exit 0;;
  esac
fi

cwd=$(hook_field '.cwd // empty')
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
tpath=$(hook_field '.transcript_path // empty')
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
  # An async subagent outlives the turn that launched it, so Stop fires while the session is
  # still waiting on one and the row would read "completed" mid-work. agent-view-subagents.sh
  # tracks the outstanding set (keyed by this same session id) and stamps the row completed
  # once the last one lands. Absent file -> no subagents tracked -> behave exactly as before.
  subfile="$dir-subagents/$sid"
  if [ -s "$subfile" ]; then
    state="working"
  else
    gitmark=$(git_review_marker "$cwd")
    [ -n "$gitmark" ] && state="review"
  fi
fi

# Staleness guard: drop a completed/review write that a newer row has already overtaken.
# `ts` is captured before git_review_marker above, so it is event time rather than write
# time, and a slow status+rev-list cannot make a stop look newer than it was. Compares
# strictly: a same-second row is NOT stale, because Stop routinely lands in the same
# second as the UserPromptSubmit that opened the turn, and skipping there would strand
# the row on "working" with no later writer to correct it. Only completed/review is
# guarded — working/needs-input always precedes its own turn's Stop.
if [ "$state" = "completed" ] || [ "$state" = "review" ]; then
  if [ -f "$file" ]; then
    disk_ts=$(jq -r '.ts // 0' < "$file" 2>/dev/null)
    case "$disk_ts" in ''|*[!0-9]*) disk_ts=0;; esac
    [ "$disk_ts" -gt "$ts" ] 2>/dev/null && exit 0
  fi
fi

av_write_full "$sid" "$state" "$cwd" "$host" "$ts" "host" "$title" "$locator" "$pane" "" "$pid" "$gitmark"
exit 0
