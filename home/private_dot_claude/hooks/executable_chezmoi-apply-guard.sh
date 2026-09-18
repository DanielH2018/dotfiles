#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Bash
#   timeout: 15
#   order: 30
# PreToolUse (Bash) hook: stop `chezmoi apply` reverting a deployed file that
# something other than chezmoi wrote.
#
# Worktree jobs deploy a build straight to its target path to exercise it in a
# real terminal, so on this machine "deployed differs from source" usually means
# the deployed copy is AHEAD, not stale — and the deployed bytes are the only
# copy. A parallel session running `chezmoi apply` then silently reverts it:
# on 2026-07-24 an in-progress agentview build was reverted mid-test.
#
# `chezmoi status` already distinguishes the two cases exactly, so this needs no
# heuristic. Its first column is the deployed file vs. the last state chezmoi
# wrote, the second is what apply will do:
#
#   " M path"   source edited, deployed untouched   -> the normal workflow, allowed
#   "MM path"   deployed edited outside chezmoi     -> apply would discard it, denied
#
# Override for a deliberate revert:  CHEZMOI_APPLY_GUARD=off chezmoi apply ...

set -u

command -v chezmoi >/dev/null 2>&1 || exit 0
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

COMMAND=$(hook_field '.tool_input.command // empty')
[ -n "$COMMAND" ] || exit 0

# Collapse continuations so a `\`-split can't hide the verb from the match below.
# shellcheck disable=SC1003  # the literal backslash is the point, not an escape
SCAN=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ')

case "$SCAN" in
  *CHEZMOI_APPLY_GUARD=off*) exit 0 ;;
esac

# `apply` writes; so does `update` (pull + apply) and `init --apply`. Everything
# else chezmoi does is read-only as far as deployed files go.
case "$SCAN" in
  *chezmoi*\ apply*|*chezmoi*\ update*|*chezmoi*--apply*) ;;
  *) exit 0 ;;
esac

# --dry-run writes nothing, so it can never clobber.
case "$SCAN" in
  *\ --dry-run*|*\ -n\ *) exit 0 ;;
esac

# Whole-tree status: cheap enough here (this hook only fires on an apply) and it
# avoids having to parse chezmoi's own flags out of the command line to find the
# targets. Our own failure must never block the user's command.
STATUS=$(chezmoi status --path-style=absolute 2>/dev/null) || exit 0
[ -n "$STATUS" ] || exit 0

# Column 1 in [ADM] means the deployed entry changed since chezmoi last wrote it;
# column 2 in [ADM] means apply would overwrite that change. Both, and only both.
CONFLICTS=$(printf '%s\n' "$STATUS" | grep -E '^[ADM][ADM] ' || true)
[ -n "$CONFLICTS" ] || exit 0

# If the command named specific targets, only conflicts on those paths matter.
# A target is an absolute or ~-rooted path: anchoring on that keeps `--flag=/x`
# and bare `owner/repo` arguments (chezmoi init) from posing as targets.
TARGETS=$(printf '%s\n' "$SCAN" | tr ' ' '\n' | grep -E '^(/|~/)' || true)
if [ -n "$TARGETS" ]; then
  MATCHED=''
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p=${line#???}
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      case "$t" in "~"*) t="$HOME${t#\~}" ;; esac
      case "$p" in "$t"|"$t"/*) MATCHED="${MATCHED}${line}"$'\n' ; break ;; esac
    done <<EOF
$TARGETS
EOF
  done <<EOF
$CONFLICTS
EOF
  CONFLICTS=$(printf '%s' "$MATCHED")
  [ -n "$CONFLICTS" ] || exit 0
fi

PATHS=$(printf '%s\n' "$CONFLICTS" | sed 's/^...//' | sed 's/^/  /')
FIRST=$(printf '%s\n' "$CONFLICTS" | head -1 | sed 's/^...//')

REASON="chezmoi apply would overwrite a file that something other than chezmoi wrote:

$PATHS

On this machine that usually means a parallel worktree job deployed a build there to test it, and the deployed bytes are the only copy — applying reverts its work mid-test. Read the change before deciding:

  chezmoi diff $FIRST

If the diff REMOVES things the source never had, another job owns that file — recover it from ~/.local/share/chezmoi/.claude/worktrees/*/ and leave it alone. If the revert is what you actually want:

  CHEZMOI_APPLY_GUARD=off ${COMMAND}"

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
