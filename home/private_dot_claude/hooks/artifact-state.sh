# shellcheck shell=bash
# Shared state for the artifact auto-refresh pair: link-artifact.sh registers the
# artifact a project is tracking, artifact-refresh.sh reads it back at Stop.
#
# Two keys, because the two halves of the state have different lifetimes.
#
# WHICH doc is tracked is keyed on the repository. A doc covering three slices of
# work outlives the session that wrote it, and the later slices often land from a
# different worktree than the one that wrote the plan — a worktree-only key would go
# silent on day two, exactly when those slices land. A worktree that writes its own
# artifact still gets its own entry, which wins over the repo one.
#
# WHOSE commits landed is keyed on the worktree. Several sessions work this repo at
# once, so an upstream-wide diff shows every other session's commits alongside yours.
# The worktree is the unit of one session's work, so that is the unit the pending
# list is scoped to.

# DECIDED: the git calls in this library run without run_bounded (#661). They read local
# refs only (rev-parse, symbolic-ref; no fetch, no network) and never walk the working
# tree. A bound would add a tempfile and a timeout(1) fork to each for a hang no one has
# seen, in the three artifact hooks that source this file. Those hooks are recorders whose
# failure costs a missed nudge, not guards.

# shellcheck disable=SC2034  # read by the hooks that source this
ARTIFACT_STATE_DIR="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"

artifact_hash_dir() {
  local d
  d=$(readlink -f "$1" 2>/dev/null) || return 1
  [[ -n "$d" ]] || return 1
  printf '%s' "$d" | sha1sum | cut -c1-16
}

# The primary checkout's git dir — shared by every worktree of the repo.
artifact_repo_slug() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  [[ -n "$common" ]] || return 1
  artifact_hash_dir "$common"
}

# This worktree's own git dir: `.git` in the primary checkout, `.git/worktrees/<name>`
# in a linked worktree, so the two never collide.
artifact_worktree_slug() {
  local dir
  dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
  [[ -n "$dir" ]] || return 1
  artifact_hash_dir "$dir"
}

# Several sessions commonly share one worktree too -- most agents here work directly
# in the primary checkout (EnterWorktree is opt-in), so artifact_worktree_slug alone
# is not enough: two unrelated sessions in the same checkout hash to the same key and
# read/write the same pending file, so one session's landed commits get reported to
# the other as if they were its own. Folding session_id into the key gives each
# session its own pending/baseline files even when the worktree slug is identical.
# Falls back to the bare worktree slug when no session_id is available (older hook
# payloads), which reproduces the pre-fix behavior rather than going silent.
artifact_session_key() {
  local wt="$1" sess="${2:-}"
  [[ -n "$wt" ]] || return 1
  if [[ -z "$sess" ]]; then
    printf '%s' "$wt"
    return 0
  fi
  printf '%s:%s' "$wt" "$sess" | sha1sum | cut -c1-16
}

# Not every repo here is `main` — the homelab server's default branch is master — so
# ask the remote what its HEAD is before falling back to guessing.
artifact_upstream_ref() {
  local head ref
  head=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)
  if [[ -n "$head" ]]; then
    printf '%s' "$head"
    return 0
  fi
  for ref in refs/remotes/origin/main refs/remotes/origin/master; do
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
      printf '%s' "$ref"
      return 0
    fi
  done
  return 1
}
