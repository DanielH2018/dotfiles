#!/bin/bash
# SessionStart: stamp where HEAD was when this session began, so
# artifact-commit-track.sh has a floor to measure its first commit against. Everything
# this session goes on to create is `HEAD --not <upstream> --not <tip>`; without the
# floor that hook records nothing at all (see its header for why claiming the branch
# instead is the bug, not the fallback).
#
# This used to record a SUBJECT LIST -- which commits were already unlanded at
# startup -- for the Stop hook to subtract. That never worked in practice: sessions
# here start on a clean master, so the list was empty (70 of 71 files, measured
# 2026-08-15) and subtracting it changed nothing, leaving every sibling session's
# commits attributed to every concurrent session. Attribution now comes from the
# session's own tool calls, and all this hook owes them is the starting point.
#
# Runs on every source, not just "startup". A resumed or cleared session needs the
# floor as much as a fresh one, and re-stamping is safe because this hook only ever
# writes `.tip` -- it never touches `.mine`, so a compaction or resume keeps whatever
# this session had already been credited with. (The old subject-list seed had to be
# startup-only for exactly that reason: it wrote the file the Stop hook read.)
#
# Best-effort and silent throughout: a failure here means commits go unattributed and
# the artifact nudge stays quiet, not that it fires with somebody else's work in it.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
session=$(hook_field '.session_id // empty')
[[ -n "$session" ]] || exit 0

# shellcheck source=/dev/null
. "${ARTIFACT_STATE_LIB:-${BASH_SOURCE[0]%/*}/artifact-state.sh}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
wt=$(artifact_worktree_slug) || exit 0
sesskey=$(artifact_session_key "$wt" "$session") || exit 0
head=$(git rev-parse --verify --quiet HEAD) || exit 0

mkdir -p "$ARTIFACT_STATE_DIR" 2>/dev/null
printf '%s\n' "$head" > "$ARTIFACT_STATE_DIR/$sesskey.tip" 2>/dev/null
exit 0
