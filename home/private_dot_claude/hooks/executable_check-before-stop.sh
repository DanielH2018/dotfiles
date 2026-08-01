#!/bin/bash
# Stop hook: verify the session didn't leave the repo in a bad state.
# If there are staged changes on a protected branch, block stopping
# and tell Claude to move them to a feature branch.

set -u

# shellcheck disable=SC1091  # optional per-host env, not present in the chezmoi tree
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# Avoid loops - if we already forced Claude to continue once, let it stop now.
ACTIVE=$(hook_field '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

# Only care about git repos.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Skip repos that commit directly to main by convention.
# The configured vault (if any) is matched by toplevel path; the dotfiles repo
# is matched by remote URL below to also cover worktrees at different paths.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "${CLAUDE_VAULT_DIR:-}" ] && [ "$TOPLEVEL" = "$CLAUDE_VAULT_DIR" ]; then
  exit 0
fi

# Skip worktrees of repos that commit directly to main by convention
# (remote URL match — covers worktrees at arbitrary paths).
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
case "$REMOTE_URL" in
  *dotfiles*) exit 0 ;;
  *DanielH2018/server.git|*DanielH2018/server) exit 0 ;;  # homelab: commits go straight to master
esac

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

# Check for in-progress rebase — leaving mid-rebase breaks the repo
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  jq -n '{
    decision: "block",
    reason: "A rebase is in progress. Complete it with `git rebase --continue` or abort with `git rebase --abort` before stopping."
  }'
  exit 0
fi

# Check for in-progress merge
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | head -5)
  if [ -n "$CONFLICTS" ]; then
    jq -n --arg files "$CONFLICTS" '{
      decision: "block",
      reason: ("Merge in progress with unresolved conflicts:\n\($files)\n\nResolve conflicts and commit, or abort with `git merge --abort`.")
    }'
  else
    jq -n '{
      decision: "block",
      reason: "A merge is in progress. Commit the merge result or abort with `git merge --abort` before stopping."
    }'
  fi
  exit 0
fi

# Check for unstaged modifications (more common than staged-only)
UNSTAGED=$(git diff --name-only 2>/dev/null | head -5)
STAGED=$(git diff --cached --name-only 2>/dev/null | head -5)

case "$BRANCH" in
  main|master|production|release)
    if [ -n "$STAGED" ]; then
      jq -n --arg branch "$BRANCH" '{
        decision: "block",
        reason: ("There are staged changes on protected branch \($branch). Please create a feature branch with `git switch -c <name>` and move the changes there before finishing.")
      }'
      exit 0
    fi
    if [ -n "$UNSTAGED" ]; then
      jq -n --arg branch "$BRANCH" --arg files "$UNSTAGED" '{
        decision: "block",
        reason: ("There are unstaged modifications on protected branch \($branch):\n\($files)\n\nPlease either stage and commit these on a feature branch, or confirm with the user that discarding them is intentional.")
      }'
      exit 0
    fi
    ;;
esac

exit 0
