# shellcheck shell=bash
# Shared state for the artifact auto-refresh pair: link-artifact.sh registers the
# artifact a project is tracking, artifact-refresh.sh reads it back at Stop.
#
# Keyed on the repository, not the session. A doc covering three slices of work
# outlives the session that wrote it, so a session-scoped key would go silent on
# day two — exactly when the later slices land.

# shellcheck disable=SC2034  # read by the hooks that source this
ARTIFACT_STATE_DIR="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"

# Hash the primary checkout's git dir rather than the working tree, so every worktree
# of a repo shares one registry entry — work lands from a worktree but the artifact
# belongs to the project.
artifact_repo_slug() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  [[ -n "$common" ]] || return 1
  common=$(readlink -f "$common" 2>/dev/null) || return 1
  printf '%s' "$common" | sha1sum | cut -c1-16
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
