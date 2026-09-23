#!/bin/bash
# gen-hooks: register
#   event: SessionEnd
#   timeout: 5
#   order: 10
#   async: true
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
#
# DECIDED: the day is the UTC day (#579, operator's call on 2026-09-23). This hook does
# not own the name. The plugin writes and reads today-<DATE>.md with its own clock:
# config.json `.timezone` via REMEMBER_TZ, and system local time when that is unset
# (pipeline/_tz.py, scripts/lib-clock.sh). The managed ~/.remember/config.json
# (home/private_dot_remember/config.json) sets `.timezone` to "UTC", so the plugin's day
# is the UTC day on every host, and tests/hooks/session-end.test.js pins that pairing.
# Change the two together: a name on one clock here and the other in the plugin rolls a
# file the plugin is not writing, on every non-UTC host, for part of every day.
REMEMBER_BUDGET=${REMEMBER_TODAY_MAX_BYTES:-8192}
PROJECT_DIR=$(hook_field '.cwd // empty')
[ -n "$PROJECT_DIR" ] || PROJECT_DIR=${CLAUDE_PROJECT_DIR:-$PWD}
TODAY_FILE="$PROJECT_DIR/.remember/today-$(date -u +%F).md"

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

# ── Learning loop: enqueue this session for an async debrief ────────────────
# Mechanism A of ~/.claude/specs/learning-loop_2026-08-19.md. SessionEnd output
# is informational and never reaches Claude (see the header above), so the
# debrief cannot ask the live model anything. This hook only enqueues the
# transcript and kicks the digest off detached; the writing happens in a
# headless run of the learning-digest skill.
#
# Tuning: CLAUDE_LEARN_DEBRIEF=0 turns it off. CLAUDE_LEARN_MIN_TOOLS sets the
# tool-call floor below which a session is too trivial to debrief (default 25).
#
# The floor reads reprime-nudge.sh's per-session counter, where the byte count
# of the .count file IS the tool-call count. That file only exists when the
# reprime nudge is armed; with CLAUDE_REPRIME_EVERY=0 the count is absent, which
# reads as 0 tool calls and no session ever debriefs.
learning_enqueue() {
  [ "${CLAUDE_LEARN_DEBRIEF:-1}" = "0" ] && return 0

  TRANSCRIPT=$(hook_field '.transcript_path // empty')
  [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || return 0

  MIN="${CLAUDE_LEARN_MIN_TOOLS:-25}"
  case "$MIN" in '' | *[!0-9]*) MIN=25 ;; esac

  COUNTF="$HOME/.claude/logs/reprime-state/$SESSION_ID.count"
  TOOLS=0
  [ -f "$COUNTF" ] && TOOLS=$(wc -c < "$COUNTF" 2>/dev/null | tr -d ' ')
  case "$TOOLS" in '' | *[!0-9]*) TOOLS=0 ;; esac

  if [ "$TOOLS" -lt "$MIN" ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=learn_skip tools=$TOOLS floor=$MIN" >> "$LOG_DIR/sessions.log"
    return 0
  fi

  QUEUE_DIR="$HOME/.claude/logs/learning-queue"
  mkdir -p "$QUEUE_DIR" 2>/dev/null || return 0
  # One atomic append per session. The digest claims the whole file by renaming
  # it, so a session that ends mid-drain lands in the next drain rather than
  # being lost.
  printf '%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SESSION_ID" "${PROJECT_DIR:-unknown}" "$TRANSCRIPT" \
    >> "$QUEUE_DIR/pending.tsv" || return 0

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=learn_queued tools=$TOOLS" >> "$LOG_DIR/sessions.log"

  # Fire the digest detached. run-skill.sh is idempotent per UTC day, so a
  # second session that day no-ops here and its queue entry waits for the next
  # drain. Detached because this hook runs under a 5s timeout.
  RUNNER="$HOME/.claude/scheduled/run-skill.sh"
  [ -x "$RUNNER" ] || return 0
  # $0-passing rather than interpolation: /bin/bash here is 3.2, which has no
  # ${var@Q}, and $HOME may contain a space.
  nohup /bin/zsh -lc 'exec "$0" learning-digest headless' "$RUNNER" >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

learning_enqueue

# ── Scan the finished transcript for credentials that reached it ───────────
# The Bash guard denies a command before it runs; it cannot cover a `grep` that happens to
# print a line CARRYING a key, because that command names no secret path and no decrypt
# verb. Nothing can be scrubbed after the fact either — no hook rewrites a tool result — so
# the transcript is scanned instead and the answer is a rotation, not a redaction.
#
# Detached, like the digest above and for the same reason: this hook runs under a 5s
# timeout, and extracting then scanning a long transcript takes longer than that. The
# daily timer (claude-transcript-scan.timer) covers every session this never completed
# for — a kill -9, a crash, or a scan outliving its parent.
leak_scan() {
  SCANNER="$HOME/.local/bin/claude-transcript-scan"
  [ -x "$SCANNER" ] || return 0
  T=$(hook_field '.transcript_path // empty')
  [ -n "$T" ] && [ -f "$T" ] || return 0
  # Not /dev/null. Findings themselves now survive in the scanner's pending marker, which
  # session-context.sh reads back — but the could-not-evaluate path (exit 3: no gitleaks,
  # no jq) announces itself only on stderr, and discarding that makes a detector that never
  # ran indistinguishable from one that ran clean. Truncated, not appended: this is the last
  # run's diagnosis rather than a history, and an unattended append grows without bound.
  RUNLOG="$HOME/.claude/logs/transcript-scan-last.log"
  mkdir -p "${RUNLOG%/*}"
  nohup "$SCANNER" --session "$T" >"$RUNLOG" 2>&1 &
  disown 2>/dev/null || true
}

leak_scan

exit 0
