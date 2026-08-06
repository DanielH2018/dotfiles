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
