#!/usr/bin/env bash
# Shared write path for the Agent View session registry (~/.claude/agent-view/).
# Sourced by the host state hook (agent-view-state.sh) and the sandbox launcher
# (claude-sandbox) so both write/remove registry rows the same way — one JSON file
# per live session, `<key>.json`. Emits NOTHING on stdout. Never `set -e` here; a
# caller sourcing this must not inherit failure-on-error.
#
# Backends (terminal-specific focus target), captured once at session start:
#   tmux:<socket_path>:<session>:<pane_id>   $TMUX set — portable across any outer terminal
#   wezterm:<pane_id>                        $WEZTERM_PANE set, no tmux
#   none:                                    neither — list-only (no programmatic focus)
# The `locator` is opaque to the picker's core; only the matching backend's
# activate interprets it. `backend` is stored redundantly (locator's prefix) so a
# reader can group/filter without parsing.

av_dir() { printf '%s' "${AGENT_VIEW_DIR:-$HOME/.claude/agent-view}"; }

av_capture_locator() {  # echo "backend:locator" for the CURRENT pane
  if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then
    local sock sess pane
    # One call: socket disambiguates multiple servers; session is the attach target;
    # pane is the focus target. TSV-parsed so the ':'-joined locator stays unambiguous
    # (socket paths and sanitized session names carry no ':').
    IFS=$'\t' read -r sock sess pane \
      < <(tmux display -p '#{socket_path}\t#{session_name}\t#{pane_id}' 2>/dev/null)
    printf 'tmux:%s:%s:%s' "$sock" "$sess" "$pane"
  elif [ -n "${WEZTERM_PANE:-}" ]; then
    printf 'wezterm:%s' "$WEZTERM_PANE"
  else
    printf 'none:'
  fi
}

# av_write_full KEY STATE CWD HOST TS KIND TITLE LOCATOR PANE RUN
# Full record write (atomic temp+mv). MSYS_NO_PATHCONV keeps a leading-slash POSIX
# cwd intact when a native jq.exe would otherwise let Git-Bash rewrite it. Writes via
# redirect (not a jq path arg) so jq never has to open a Windows path.
av_write_full() {
  local key="$1" state="$2" cwd="$3" host="$4" ts="$5" kind="$6" title="$7" \
        locator="$8" pane="$9" run="${10}"
  local dir; dir=$(av_dir); mkdir -p "$dir" 2>/dev/null
  local file="$dir/$key.json" tmp="$dir/$key.json.tmp.$$"
  if MSYS_NO_PATHCONV=1 jq -nc \
       --arg key "$key" --arg run "$run" --arg kind "$kind" --arg cwd "$cwd" \
       --arg title "$title" --arg state "$state" --arg host "$host" \
       --arg backend "${locator%%:*}" --arg locator "$locator" \
       --arg pane "$pane" --arg session "$key" --argjson ts "${ts:-0}" \
       '{key:$key,run:$run,kind:$kind,cwd:$cwd,title:$title,state:$state,host:$host,ts:$ts,backend:$backend,locator:$locator,pane:$pane,session:$session}' \
       > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
}

# av_update_state KEY STATE — update-if-exists-only: change only state + ts, preserve
# launcher-owned identity/locator/lifecycle fields. NEVER creates the file (Phase-2
# resurrection guard: a container hook firing during teardown must not re-create a row
# the launcher's cleanup just removed).
av_update_state() {
  local key="$1" state="$2" dir file tmp ts
  dir=$(av_dir); file="$dir/$key.json"
  [ -f "$file" ] || return 0
  ts=$(date +%s 2>/dev/null || echo 0)
  tmp="$file.tmp.$$"
  if MSYS_NO_PATHCONV=1 jq -c --arg state "$state" --argjson ts "${ts:-0}" \
       '.state=$state | .ts=$ts' < "$file" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
}

# av_guarded_remove KEY [RUN] — delete the row, but only if its stored `run` still
# matches RUN (the launch-unique id). Guards the collision race: if a newer session
# ever reused the same key, an older session's exit can't delete the newer row. An
# empty RUN deletes unconditionally (host state hook, keyed by stable session id).
av_guarded_remove() {
  local key="$1" run="${2:-}" dir file cur
  dir=$(av_dir); file="$dir/$key.json"
  [ -f "$file" ] || return 0
  if [ -n "$run" ]; then
    cur=$(jq -r '.run // ""' < "$file" 2>/dev/null)
    [ "$cur" = "$run" ] || return 0
  fi
  rm -f "$file" 2>/dev/null
}
