#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 15
#   order: 50
#   statusMessage: Syncing chezmoi source...
# PostToolUse (Edit|Write) hook: keep chezmoi-managed files in sync with the
# chezmoi source, so manual/agent edits to deployed dotfiles don't silently
# drift from the repo and then get reverted by a later `chezmoi apply`.
#
#   - plain managed file        -> `chezmoi add` re-syncs the source automatically
#   - templated/scripted source -> warn only (the rendered output must not
#     overwrite its .tmpl / modify_ / create_ / run_ / symlink_ source)
#   - unmanaged file            -> no-op
#
# Re-syncing only updates the source working tree; committing in
# ~/.local/share/chezmoi stays a manual, reviewable step.

set -u

command -v chezmoi >/dev/null 2>&1 || exit 0
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

FILE=$(hook_field '.tool_input.file_path // empty')
[ -n "$FILE" ] || exit 0

# Windows: Claude Code passes paths as C:/Users/... but $HOME is the MSYS form
# /c/Users/... ; normalize so the $HOME-prefixed matching below works. cygpath is
# absent on macOS/Linux, so this is a no-op there and native paths are untouched.
if command -v cygpath >/dev/null 2>&1; then
  FILE=$(cygpath -u "$FILE" 2>/dev/null || printf '%s' "$FILE")
fi

# chezmoi targets live under $HOME; skip everything else cheaply.
case "$FILE" in
  "$HOME"/*) ;;
  *) exit 0 ;;
esac
# Never chezmoi-managed, and hot paths during normal work — bail before the
# (relatively expensive) chezmoi lookup.
case "$FILE" in
  "$HOME"/.local/share/chezmoi/*|"$HOME"/Repositories/*|"$HOME"/Documents/*) exit 0 ;;
esac

# Skip unmanaged files without starting chezmoi. The cache, its key and its knobs are
# chezmoi-managed-lib.sh's, shared with chezmoi-edit-guard.sh; a listed file still goes to
# source-path below, which stays the authority.
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/chezmoi-managed-lib.sh"
chezmoi_managed_skip "$FILE" && exit 0

# source-path exits non-zero when the file isn't managed by chezmoi.
SRC=$(chezmoi source-path "$FILE" 2>/dev/null) || exit 0
[ -n "$SRC" ] || exit 0

emit() {
  jq -n --arg msg "$1" '{
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $msg }
  }'
}

case "$(basename "$SRC")" in
  *.tmpl|modify_*|create_*|run_*|symlink_*)
    emit "chezmoi: $FILE is generated from a template/script source ($SRC). This manual edit will be reverted by \`chezmoi apply\` — update the chezmoi source instead."
    exit 0
    ;;
esac

if chezmoi add "$FILE" >/dev/null 2>&1; then
  # Windows has no exec bit, so `chezmoi add` re-adds the file without the
  # executable_ attribute the source had — restore it or a later apply on
  # macOS/Linux strips the exec bit and the hook/script stops running.
  case "$(basename "$SRC")" in
    executable_*|*_executable_*) chezmoi chattr +executable "$FILE" >/dev/null 2>&1 ;;
  esac
  emit "chezmoi: re-synced source for managed file $FILE. Commit it in ~/.local/share/chezmoi when ready."
else
  emit "chezmoi: could not re-sync source for managed file $FILE — check \`chezmoi status\`."
fi
exit 0
