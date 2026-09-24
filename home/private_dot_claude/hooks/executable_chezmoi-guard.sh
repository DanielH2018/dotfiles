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

emit() {
  jq -n --arg msg "$1" '{
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $msg }
  }'
}

# Every chezmoi call below runs through run_bounded, like every other hook child (#581).
# They used to run bare, so a chezmoi that hung held the hook until the harness killed it
# at 15s, and the edit was left unsynced with nothing said. The four bounds add up to
# less than that 15s: 2s for chezmoi-managed-lib.sh's `chezmoi managed`, then the three
# below. CHEZMOI_GUARD_TIMEOUT_S sets those three, for the tests.
#
# A missing library is reported rather than run around: this file may be managed, and if it
# is, the next apply reverts the edit unless someone re-syncs it.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  emit "chezmoi-guard: cannot load $RUN_BOUNDED_PATH, so $FILE was not checked against the chezmoi source -- not evaluated. If it is managed, run \`chezmoi add $FILE\`."
  exit 0
fi
T_LOOKUP=${CHEZMOI_GUARD_TIMEOUT_S:-3}
T_ADD=${CHEZMOI_GUARD_TIMEOUT_S:-7}
T_CHATTR=${CHEZMOI_GUARD_TIMEOUT_S:-2}

# Skip unmanaged files without starting chezmoi. The cache, its key and its knobs are
# chezmoi-managed-lib.sh's, shared with chezmoi-edit-guard.sh; a listed file still goes to
# source-path below, which stays the authority. After the library load, because the
# cache refresh runs through run_bounded too (#657).
# shellcheck source=/dev/null
. "${BASH_SOURCE[0]%/*}/chezmoi-managed-lib.sh"
chezmoi_managed_skip "$FILE" && exit 0

# source-path exits non-zero when the file isn't managed by chezmoi. Its stderr is dropped
# inside the child, because run_bounded merges the two streams and SRC must be the path alone.
# shellcheck disable=SC2016  # $1 belongs to the inner bash
run_bounded "$T_LOOKUP" 65536 -- bash -c 'exec chezmoi source-path "$1" 2>/dev/null' _ "$FILE"
if [ "$RB_STATUS" != ok ]; then
  emit "chezmoi-guard: \`chezmoi source-path\` did not answer within ${T_LOOKUP}s ($RB_STATUS), so it is unknown whether $FILE is managed -- not evaluated. Check \`chezmoi status\`."
  exit 0
fi
[ "$RB_EXIT" -eq 0 ] || exit 0
SRC=$RB_OUT
[ -n "$SRC" ] || exit 0

case "$(basename "$SRC")" in
  *.tmpl|modify_*|create_*|run_*|symlink_*)
    emit "chezmoi: $FILE is generated from a template/script source ($SRC). This manual edit will be reverted by \`chezmoi apply\` — update the chezmoi source instead."
    exit 0
    ;;
esac

run_bounded "$T_ADD" 65536 -- chezmoi add "$FILE"
if [ "$RB_STATUS" = ok ] && [ "$RB_EXIT" -eq 0 ]; then
  # Windows has no exec bit, so `chezmoi add` re-adds the file without the
  # executable_ attribute the source had — restore it or a later apply on
  # macOS/Linux strips the exec bit and the hook/script stops running.
  note=''
  case "$(basename "$SRC")" in
    executable_*|*_executable_*)
      run_bounded "$T_CHATTR" 65536 -- chezmoi chattr +executable "$FILE"
      if [ "$RB_STATUS" != ok ] || [ "$RB_EXIT" -ne 0 ]; then
        note=" But \`chezmoi chattr +executable\` did not complete ($RB_STATUS), so the source may have lost its executable_ prefix -- check it."
      fi
      ;;
  esac
  emit "chezmoi: re-synced source for managed file $FILE. Commit it in ~/.local/share/chezmoi when ready.$note"
elif [ "$RB_STATUS" != ok ]; then
  emit "chezmoi: could not re-sync source for managed file $FILE — \`chezmoi add\` did not finish within ${T_ADD}s ($RB_STATUS). Check \`chezmoi status\`."
else
  emit "chezmoi: could not re-sync source for managed file $FILE — check \`chezmoi status\`."
fi
exit 0
