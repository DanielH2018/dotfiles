#!/bin/bash
# SessionEnd hook: log session summary and check for unsaved work.
# Fires when a session terminates. Output is informational only (not shown to Claude).

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
SESSION_ID=$(hook_field '.session_id // "unknown"')

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

# Log session end timestamp
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=end" >> "$LOG_DIR/sessions.log"

# If in a git repo, warn about uncommitted changes left behind
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  STAGED=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')

  if [ "$DIRTY" -gt 0 ] || [ "$STAGED" -gt 0 ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=dirty_exit branch=$BRANCH dirty=$DIRTY staged=$STAGED" >> "$LOG_DIR/sessions.log"
  fi
fi

# ── Bound the remember plugin's daily buffer ───────────────────────────────
# The plugin's SessionStart hook cats today-<DATE>.md whole into every new
# session. Nothing bounds it: both the save and NDC prompts mandate lossless
# compression ("Keep ALL facts", "Zero information loss"), so the file only
# grows. Measured 2026-07-25: 44.8 KB across 87 entries, ~21k tokens injected
# per session. At 45 KiB (46080 B) the harness stops injecting it and delivers
# a 2 KB preview instead, which quietly guts the feature — the largest payload
# that still landed whole was 46077 B, three bytes under the cap.
#
# Roll the buffer past a budget. The "-N" sibling drops out of the injection
# list at once (the hook cats only the exact today-<DATE>.md), and the plugin's
# own consolidation folds it into recent.md on the next day's run — pipeline/
# shell.py skips staging files whose name contains the current date, so it sits
# untouched today and is picked up tomorrow.
REMEMBER_BUDGET=${REMEMBER_TODAY_MAX_BYTES:-8192}
PROJECT_DIR=$(hook_field '.cwd // empty')
[ -n "$PROJECT_DIR" ] || PROJECT_DIR=${CLAUDE_PROJECT_DIR:-$PWD}
TODAY_FILE="$PROJECT_DIR/.remember/today-$(date +%F).md"

if [ -f "$TODAY_FILE" ]; then
  SIZE=$(wc -c < "$TODAY_FILE" 2>/dev/null | tr -d ' ')
  if [ -n "$SIZE" ] && [ "$SIZE" -gt "$REMEMBER_BUDGET" ]; then
    N=1
    while [ -e "${TODAY_FILE%.md}-$N.md" ]; do N=$((N + 1)); done
    if mv "$TODAY_FILE" "${TODAY_FILE%.md}-$N.md" 2>/dev/null; then
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=remember_roll bytes=$SIZE budget=$REMEMBER_BUDGET part=$N" >> "$LOG_DIR/sessions.log"
    fi
  fi
fi

exit 0
