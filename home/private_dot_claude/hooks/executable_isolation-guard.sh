#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 10
#   order: 60
# Enforces "Working in isolation" from CLAUDE.md: a background job whose
# EnterWorktree failed and fell back to "continue in place" must not edit the
# shared checkout. No-ops outside a background job (CLAUDE_JOB_DIR unset) and
# inside a .claude/worktrees/ checkout, so this never fires in an ordinary
# interactive session. Bash writes (sed -i, heredocs, tee) are not covered here
# -- see isolation-guard.sh's own comment for why extending
# bash-write-fanout.sh's post-hoc path extraction to a pre-execution deny was
# left undone.
# PreToolUse (Edit|Write|NotebookEdit) hook: a background job that failed to isolate
# must not edit the shared checkout it landed in instead.
#
# The rule this replaces lived only in CLAUDE.md prose ("Working in isolation"): retry
# EnterWorktree once, and if it fails again, make no edits — report the failure and stop.
# A background-job harness whose EnterWorktree call fails can fall back to "continue in
# place", which is the shared checkout every other session (and the primary user) also
# reads from — an edit there from a job with no isolation is exactly the failure mode the
# prose warns about, and nothing but the model's own memory of a paragraph stopped it.
#
# Scope: only background jobs (CLAUDE_JOB_DIR set — unset in an interactive session, so
# this is a no-op there) editing a path that sits inside a git working tree but not under
# a `.claude/worktrees/` directory. A path outside any git repo (scratch space, including
# $CLAUDE_JOB_DIR/tmp) is not a repo edit and is left alone, same as the prose says.
#
# Deliberately best-effort on the git-repo test: if the nearest existing ancestor
# directory can't be resolved to a work tree (permissions, chezmoi not on PATH, an
# unusual mount), the failure direction is a missed deny, never a wrong one — same
# philosophy as chezmoi-guard.sh and bash-write-fanout.sh.

set -u

# Cheapest possible bail, before touching stdin: only a background job is in scope.
[ -n "${CLAUDE_JOB_DIR:-}" ] || exit 0

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq ask "isolation-guard: jq is unavailable, so isolation could not be verified. Confirm this session is in a .claude/worktrees/ checkout before allowing." || exit 0

FILE=$(hook_field '.tool_input.file_path // empty')
[ -n "$FILE" ] || exit 0

# Already isolated: a session inside .claude/worktrees/ is already isolated (CLAUDE.md),
# regardless of what triggered it.
case "$FILE" in
  */.claude/worktrees/*|*/.claude/worktrees) exit 0 ;;
esac

# Find the nearest existing ancestor directory -- Write can target a path that doesn't
# exist yet, and `git -C` on a non-existent directory answers nothing useful.
DIR=$FILE
[ -d "$DIR" ] || DIR=$(dirname "$DIR")
while [ ! -d "$DIR" ] && [ "$DIR" != "/" ] && [ "$DIR" != "." ]; do
  DIR=$(dirname "$DIR")
done
[ -d "$DIR" ] || exit 0

INSIDE=$(git -C "$DIR" rev-parse --is-inside-work-tree 2>/dev/null) || exit 0
[ "$INSIDE" = "true" ] || exit 0

jq -n --arg file "$FILE" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("Blocked: " + $file + " is in a shared git checkout outside .claude/worktrees/, and this is a background job (CLAUDE_JOB_DIR set). Retry EnterWorktree once. If it fails again, make no edits -- report the failure and stop.")
  }
}'
exit 0
