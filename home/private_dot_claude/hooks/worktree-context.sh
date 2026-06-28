#!/bin/bash
# UserPromptSubmit hook: inject worktree branch context when in a linked worktree.
# Helps Claude remember which feature branch it's working on after compaction.

set -u

# Only relevant inside a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)

# Detect linked worktree: .git is a file (not a directory) pointing to the main repo.
[ -f "$TOPLEVEL/.git" ] || exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

jq -n --arg branch "$BRANCH" '{
  appendToPrompt: "[Worktree: \($branch)]"
}'
