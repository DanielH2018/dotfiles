#!/bin/bash
# Stop hook: verify the session didn't leave the repo in a bad state.
# If there are staged changes on a protected branch, block stopping
# and tell Claude to move them to a feature branch.

set -u

INPUT=$(cat)

# Avoid loops - if we already forced Claude to continue once, let it stop now.
ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

# Only care about git repos.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Skip repos that commit directly to main by convention.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
case "$TOPLEVEL" in
  "$HOME/.dotfiles"|"$HOME/Documents/My_Vault") exit 0 ;;
esac

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

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
