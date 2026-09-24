#!/bin/bash
# gen-hooks: register
#   event: PreCompact
#   matcher: auto|manual
#   timeout: 10
#   order: 10
# PreCompact hook: fires on both auto-compact and manual /compact.
#
# Compaction is where the CLAUDE.md compaction policy is most likely to lose things, so this
# re-injects the parts that are cheap to recover from ground truth rather than from the summary:
# branch and push state, files touched this session, and the test commands actually run.
# Derived facts beat a summarizer's recollection of them.
#
# CLAUDE.md tells sessions not to run /compact themselves and to let the 85% auto-threshold
# fire. Compacting at a quarter of the threshold throws away half a million tokens of headroom.
# Keep this hook: it costs nothing on the auto path, which consults no precompute at all. The
# background precompute is consulted only on the manual path, and this hook matches
# `auto|manual`, so that lookup short-circuits to `miss_hook` — a manual compaction can never
# hit the precompute while this hook exists.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
TRIGGER=$(hook_field '.trigger // "auto"')
[ -n "$TRIGGER" ] || TRIGGER=auto
TRANSCRIPT=$(hook_field '.transcript_path // empty')

case "$TRIGGER" in
  manual) MSG="Manual /compact proceeding." ;;
  *)      MSG="Auto-compact proceeding." ;;
esac

# Git state: branch, recent commits, uncommitted work, and whether it is pushed.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  DIRTY=$(git status --porcelain 2>/dev/null | head -10)
  RECENT=$(git log -3 --pretty=format:'  %h %s' 2>/dev/null)

  if UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null); then
    AHEAD=$(git rev-list --count "$UPSTREAM"..HEAD 2>/dev/null || echo '?')
    if [ "$AHEAD" = "0" ]; then
      PUSHED="pushed (up to date with $UPSTREAM)"
    else
      PUSHED="NOT pushed — $AHEAD commit(s) ahead of $UPSTREAM"
    fi
  else
    PUSHED="NOT pushed — no upstream set for this branch"
  fi

  MSG="$MSG

Post-compact git context (branch: $BRANCH):
Push state: $PUSHED
Recent commits:
$RECENT"

  if [ -n "$DIRTY" ]; then
    MSG="$MSG

Uncommitted changes:
$DIRTY"
  fi
fi

# Transcript-derived state. One pass over the JSONL, tagging each row so files and commands
# come out of the same scan: F = a file this session edited, B = a shell command it ran.
if [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ]; then
  SCAN=$(jq -Rr '
    fromjson?
    | (.message.content? // empty)
    | select(type == "array")
    | .[]
    | select(type == "object" and .type == "tool_use")
    | if (.name == "Edit" or .name == "Write" or .name == "NotebookEdit")
      then "F\t" + (.input.file_path // .input.notebook_path // "")
      elif .name == "Bash"
      then "B\t" + ((.input.command // "") | split("\n")[0])
      else empty
      end' "$TRANSCRIPT" 2>/dev/null || true)

  # Scratch files under a job's tmp dir are not "work done" — they'd crowd the real edits
  # out of the list, which is the opposite of the point.
  FILES=$(printf '%s\n' "$SCAN" | sed -n 's/^F\t//p' | grep -v '^$' \
    | grep -vE '^(/tmp/|.*/\.claude/jobs/[^/]+/tmp/)' | sort -u)
  FILE_COUNT=$(printf '%s\n' "$FILES" | grep -c . || true)

  # Only the commands that look like a test/build gate — those are the ones whose
  # results the compaction policy asks to keep. Deduped oldest-first, and truncated:
  # a reminder that a suite ran costs a line, not the whole compound invocation.
  TESTS=$(printf '%s\n' "$SCAN" | sed -n 's/^B\t//p' \
    | grep -aE '(^|[[:space:];&|])((npm|pnpm|yarn|bun)[[:space:]]+(run[[:space:]]+)?test|pytest|jest|vitest|node[[:space:]]+--test|cargo[[:space:]]+test|go[[:space:]]+test|make[[:space:]]+(test|check)|tox|rspec)' \
    | awk '!seen[$0]++' | tail -5 | cut -c1-120)

  if [ "${FILE_COUNT:-0}" -gt 0 ]; then
    MSG="$MSG

Files modified this session ($FILE_COUNT):
$(printf '%s\n' "$FILES" | head -25 | sed 's/^/  /')"
    if [ "$FILE_COUNT" -gt 25 ]; then
      MSG="$MSG
  ... and $((FILE_COUNT - 25)) more"
    fi
  fi

  if [ -n "$TESTS" ]; then
    MSG="$MSG

Test commands run (most recent last) — re-run to confirm status, do not assume it from here:
$(printf '%s\n' "$TESTS" | sed 's/^/  /')"
  fi
fi

MSG="$MSG

Preserve verbatim across this boundary: user corrections, exact error strings, and current task
state. The summary must also keep, exactly: (1) problems that came up and how they were resolved;
(2) approaches raised, tried, or set aside, and why; (3) anything asked for, decided, ruled out,
or established as a constraint, in the user's own words; (4) where things stand now — covered,
settled, completed; (5) anything still open, promised, or expected next; (6) details that are hard
to reconstruct — names, numbers, dates, paths, links. Be complete on these even at the cost of
length; condense your own reasoning to what it concluded. If this session contains important
decisions or feedback, use the remember skill now."

jq -n --arg msg "$MSG" '{
  "continue": true,
  "systemMessage": $msg
}'
