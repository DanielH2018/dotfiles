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

# Skip for the dotfiles repo — committing directly to main is expected there.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
[ "$GIT_DIR" = "$HOME/.dotfiles" ] && exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
case "$BRANCH" in
  main|master|production|release)
    if ! git diff --cached --quiet 2>/dev/null; then
      jq -n --arg branch "$BRANCH" '{
        decision: "block",
        reason: ("There are staged changes on protected branch \($branch). Please create a feature branch with `git switch -c <name>` and move the changes there before finishing.")
      }'
      exit 0
    fi
    ;;
esac

exit 0
