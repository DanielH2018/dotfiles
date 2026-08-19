#!/usr/bin/env bash
# Label this session's row in Warp's vertical tab sidebar with its state and Claude's own
# session title, so the sidebar reads like the Agent View picker it replaces.
#
# Warp renders a terminal pane's OSC 0 title verbatim as the sidebar row label, which is the
# whole mechanism here: there is no Warp API involved and nothing to keep in sync. An escape
# sequence is just terminal output, so this works identically through ssh — a session on
# daniel-box labels its own row on this desktop.
#
# The sequence goes to the CONTROLLING TERMINAL, never stdout. A hook's stdout is read by
# Claude Code as hook output; printing an escape there would feed it to the model instead of
# the terminal. No tty (headless, `claude -p`) -> silently do nothing.
#
# Usage: warp-session-title.sh <start|working|needs-input|completed|end>
set -u
state="${1:-idle}"

# Everything below writes to the terminal, so a session with no controlling terminal has
# nothing to label. Bail before doing any work rather than after.
tty_out="${WARP_TITLE_TTY:-/dev/tty}"   # overridable so the test suite can capture the sequence
[[ -w "$tty_out" ]] 2>/dev/null || exit 0

# shellcheck source=/dev/null
source "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# Headless sdk invocations (the remember plugin's summarizers, and anything else driving
# `claude -p`) fire these same hooks but own no pane worth labelling. agent-view-state.sh
# filters them the same way and for the same reason. An absent registry file means "older
# claude, don't know" -> label anyway, matching that hook's looser filter on non-start events.
if [[ -n "${CLAUDE_PID:-}" ]]; then
  case "$(jq -r '.entrypoint // ""' "$HOME/.claude/sessions/${CLAUDE_PID}.json" 2>/dev/null)" in
    sdk*) exit 0;;
  esac
fi

# SessionEnd: hand the row back to Warp's own auto-title rather than leaving a stale
# "working" label on a pane whose session is gone. An empty OSC 0 string is the reset.
if [[ "$state" == "end" ]]; then
  printf '\033]0;\007' > "$tty_out" 2>/dev/null
  exit 0
fi

# Claude's OWN title, by the same precedence its UI uses: a user-set `custom-title` (via
# /rename) wins over the automatic `ai-title`. grep first so a multi-MB JSONL transcript
# costs one scan rather than a jq parse per line, then take the latest of that type.
title=""
tpath=$(hook_field '.transcript_path // empty')
if [[ -n "$tpath" ]] && [[ -f "$tpath" ]]; then
  ct=$(grep -aF '"custom-title"' "$tpath" 2>/dev/null | jq -r 'select(.type=="custom-title") | .customTitle // empty' 2>/dev/null | tail -1)
  if [[ -n "$ct" ]]; then title="$ct"
  else
    at=$(grep -aF '"ai-title"' "$tpath" 2>/dev/null | jq -r 'select(.type=="ai-title") | .aiTitle // empty' 2>/dev/null | tail -1)
    [[ -n "$at" ]] && title="$at"
  fi
fi

# Before Claude has titled the session there is nothing to show, and a bare state word is a
# useless row when several sessions are open. The working directory's basename distinguishes
# them from the first turn, which is exactly when the title is still missing.
if [[ -z "$title" ]]; then
  cwd=$(hook_field '.cwd // empty')
  [[ -z "$cwd" ]] && cwd="$PWD"
  title=$(basename "$cwd" 2>/dev/null)
fi

# Words, not glyphs: the sidebar row is already narrow and truncates from the right, so a
# leading marker has to survive being the only thing visible.
case "$state" in
  start|idle)  label="idle" ;;
  working)     label="working" ;;
  needs-input) label="input" ;;
  completed)   label="done" ;;
  *)           label="$state" ;;
esac

# Strip the C0 controls that would terminate the sequence early or corrupt the row. A title
# carrying a stray BEL or ESC comes straight from the transcript, so it is not hypothetical.
clean=$(printf '%s · %s' "$label" "$title" | tr -d '\000-\037')

printf '\033]0;%s\007' "$clean" > "$tty_out" 2>/dev/null
exit 0
