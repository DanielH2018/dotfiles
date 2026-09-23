#!/bin/bash
# gen-hooks: register
#   event: UserPromptSubmit
#   timeout: 5
#   order: 20
# UserPromptSubmit hook: inject worktree branch context when in a linked worktree.
# Helps Claude remember which feature branch it's working on after compaction.

set -u

# The jq-missing policy, expressed once (hook-input.sh, hook_require_jq) rather than
# left implicit. Without it this hook exited 127 and printed `jq: command not found`
# to the harness's hook-stderr channel on every prompt in a worktree on a machine
# without jq. A missing branch banner is a no-op, not an error: noop. This hook reads
# no stdin, so it never calls hook_read_input.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_require_jq noop || exit 0

# Only relevant inside a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Detect a *linked* worktree: its per-worktree git dir differs from the shared
# common dir. A plain ".git is a file" check is too loose — it also matches
# bare-repo dotfiles checkouts (~/.git → "gitdir: ~/.dotfiles") and submodules,
# which would inject a spurious "[Worktree: <branch>]" into every prompt.
# Resolve both dirs the same way (physical, symlink-normalized) so the comparison
# isn't fooled by e.g. /var → /private/var symlinks.
GIT_DIR_RAW=$(git rev-parse --git-dir 2>/dev/null) || exit 0
COMMON_RAW=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
GIT_DIR_ABS=$(cd "$GIT_DIR_RAW" 2>/dev/null && pwd -P) || exit 0
COMMON_ABS=$(cd "$COMMON_RAW" 2>/dev/null && pwd -P) || exit 0
[ "$GIT_DIR_ABS" != "$COMMON_ABS" ] || exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ -z "$BRANCH" ] && exit 0

jq -n --arg branch "$BRANCH" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "[Worktree: \($branch)]"
  }
}'
