#!/bin/bash
# SessionStart (matcher: startup only): record which currently-unlanded commits on
# this branch predate this session, so artifact-refresh.sh's Stop hook can tell "a
# sibling session's still-unlanded work" apart from "this session's own work" when
# several sessions share one checkout (the common case here -- EnterWorktree is
# opt-in, most agents work directly in the primary checkout).
#
# Without this baseline, artifact-refresh.sh has no way to attribute an unlanded
# commit to a session: `git log ref..HEAD` is shared branch state, not per-process, so
# every session sees the exact same list regardless of who wrote it. Recording that
# list here, before this session's own first commit, lets the Stop hook later treat
# only NEW entries (ones absent from this file) as "mine".
#
# Runs on "startup" only, not "compact" -- session_id is stable across a compaction,
# so reseeding there would discard whatever this session had already accumulated as
# genuinely its own, right before the Stop hook needed to read it.
#
# Best-effort and silent throughout: a failure here just means artifact-refresh.sh
# falls back to its pre-fix behavior (attribute everything unlanded), not a bad decision.

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
ref=$(artifact_upstream_ref) || exit 0
sesskey=$(artifact_session_key "$wt" "$session") || exit 0

mkdir -p "$ARTIFACT_STATE_DIR" 2>/dev/null
git log --format=%s "$ref..HEAD" > "$ARTIFACT_STATE_DIR/$sesskey.baseline" 2>/dev/null
exit 0
