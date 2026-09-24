#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 10
#   order: 55
# PreToolUse (Edit|Write) hook: refuse an edit to a deployed file whose chezmoi source is a
# template or a script, and name the source to edit instead (#574).
#
# chezmoi-guard.sh (PostToolUse) handles the other kind of managed file: a plain one it
# re-syncs into the source with `chezmoi add`. A .tmpl / modify_ / run_ source cannot take
# that, because the deployed bytes are its OUTPUT, so chezmoi-guard.sh can only warn after
# the edit has landed. The edit then stays live and wrong until the next `chezmoi apply`
# reverts it. Deciding before the edit turns that warning into a pointer at the right file.
#
#   .tmpl, modify_, run_ source   deny, printing the source path
#   ~/.claude/settings.json       deny, naming settings.base.json (its modify_ script merges
#                                 that template with the work overlay)
#   plain managed file            no decision; chezmoi-guard.sh re-syncs it afterwards
#   create_, symlink_ source      no decision; apply does not revert those
#   unmanaged file                no decision
#
# Override for a deliberate throwaway edit: start the session with CHEZMOI_EDIT_GUARD=off.
#
# Every failure is no decision: no chezmoi, no jq, a source-path that fails. A missed deny
# leaves chezmoi-guard.sh's warning in place, which is what happened before this hook.

set -u

command -v chezmoi >/dev/null 2>&1 || exit 0
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
# After the read, not before: a hook that exits with its stdin unread can hand the writer
# an EPIPE, which the test runner reports as a failure under load.
[ "${CHEZMOI_EDIT_GUARD:-}" = "off" ] && exit 0
hook_require_jq noop || exit 0

FILE=$(hook_field '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -n "$FILE" ] || exit 0

# Windows: Claude Code passes C:/Users/... while $HOME is /c/Users/... (chezmoi-guard.sh).
if command -v cygpath >/dev/null 2>&1; then
  FILE=$(cygpath -u "$FILE" 2>/dev/null || printf '%s' "$FILE")
fi

case "$FILE" in
  "$HOME"/*) ;;
  *) exit 0 ;;
esac
# The source tree (worktrees included) is where the edit belongs, and the other two are
# hot paths chezmoi never manages.
case "$FILE" in
  "$HOME"/.local/share/chezmoi/*|"$HOME"/Repositories/*|"$HOME"/Documents/*) exit 0 ;;
  */.claude/worktrees/*) exit 0 ;;
esac

# Skip unmanaged files without starting chezmoi: this runs before every Edit and Write and
# almost none of them touch a managed file. The cache is chezmoi-managed-lib.sh's, shared
# with chezmoi-guard.sh and keyed on the source tree, so a file that becomes managed misses
# it on the next call. A listed file still goes to source-path below, the authority.
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/chezmoi-managed-lib.sh"
chezmoi_managed_skip "$FILE" && exit 0

SRC=$(chezmoi source-path "$FILE" 2>/dev/null) || exit 0
[ -n "$SRC" ] || exit 0

case "${SRC##*/}" in
  *.tmpl|modify_*|run_*) ;;
  *) exit 0 ;;
esac

if [ "$FILE" = "$HOME/.claude/settings.json" ]; then
  BASE="${SRC%/private_dot_claude/*}/.chezmoitemplates/settings.base.json"
  REASON="Blocked: $FILE is generated. Its source, $SRC, merges $BASE with the machine-local work overlay, so a hand edit here is reverted by the next \`chezmoi apply\`.

Edit $BASE instead (in your worktree's copy when you are in one). Its hooks block is itself generated: a hook registers in the \`# gen-hooks:\` block at the top of its file, and bin/gen-hooks renders it. Then: chezmoi apply ~/.claude/settings.json"
else
  REASON="Blocked: $FILE is rendered by chezmoi from $SRC, a template or script source, so a hand edit here is reverted by the next \`chezmoi apply\`.

Edit the source instead (in your worktree's copy when you are in one), then run: chezmoi apply $FILE"
fi

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
