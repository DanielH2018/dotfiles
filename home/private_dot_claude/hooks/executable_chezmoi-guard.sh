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

# Negative cache in front of the chezmoi call. Starting the binary costs ~41ms and this
# hook runs after every Edit and Write (~900/day), while the overwhelming majority of those
# edits are to files chezmoi has never managed — scratch dirs, worktrees, repos. Caching the
# managed set turns that question into a string match; `chezmoi managed` costs ~33ms once
# per change to its inputs instead of ~41ms every time.
#
# Used ONLY to skip: a path absent from the cache exits, a path present falls through to the
# real `source-path` call below, which stays the authority on where the source is. That
# asymmetry is what makes a stale cache safe in one direction — a file that has *stopped*
# being managed still hits source-path, which fails, and the hook exits as it always did.
#
# The direction that is not free is a file that BECOMES managed, so the cache is keyed on
# its inputs rather than on its age (#579): a cksum of every path in the source tree, the
# contents of its .chezmoi* control files, and the chezmoi config. `chezmoi add`, a new
# .chezmoiignore line, a branch switch and a config edit all change the key, and the next
# call refetches. File contents outside the .chezmoi* files are left out: they decide what
# a target renders to, not whether it is managed. Measured 2026-09-23 on an 874-file
# source: one no-match walk takes ~7ms, against ~36ms for `chezmoi managed`.
#
# The key walks the default source dir; CHEZMOI_GUARD_SOURCE_DIR points it elsewhere. With
# no such directory there is nothing to key on, so every call asks chezmoi.
# CHEZMOI_GUARD_CACHE=0 turns the cache off.
_cg_src="${CHEZMOI_GUARD_SOURCE_DIR:-$HOME/.local/share/chezmoi}"
if [ "${CHEZMOI_GUARD_CACHE:-1}" != 0 ] && [ -d "$_cg_src" ]; then
  _cg_cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-hooks/chezmoi-managed"
  _cg_fresh=''
  # Two walks rather than one: interleaving -print with an -exec'd cat would leave the
  # order of the two streams to buffering, and a key that varies between identical trees
  # never hits. .git and the worktrees under .claude are not source state.
  _cg_key=$( {
    find "$_cg_src" \( -path "$_cg_src/.git" -o -path "$_cg_src/.claude" \) -prune -o -print
    find "$_cg_src" \( -path "$_cg_src/.git" -o -path "$_cg_src/.claude" \) -prune -o \
      -type f -name '.chezmoi*' -exec cat {} +
    cat "${XDG_CONFIG_HOME:-$HOME/.config}"/chezmoi/chezmoi.*
  } 2>/dev/null | cksum)
  # -f, not -s: "chezmoi manages nothing here" is a legitimate answer and an empty cache is
  # the correct way to record it. Testing for non-empty instead made that case look like a
  # failed refresh, so the cache never engaged and every call still paid for chezmoi.
  if [ -f "$_cg_cache" ] && [ -f "$_cg_cache.key" ]; then
    _cg_old=''
    IFS= read -r _cg_old < "$_cg_cache.key" 2>/dev/null
    [ "$_cg_old" = "$_cg_key" ] && _cg_fresh=1
  fi
  if [ -z "$_cg_fresh" ]; then
    mkdir -p "${_cg_cache%/*}" 2>/dev/null
    # Exit status is the only signal that separates "nothing is managed" from "the query
    # failed". A failed refresh leaves no cache, so the next call asks chezmoi directly.
    # The key lands after the list, so a reader never pairs a new key with an old list.
    if chezmoi managed --path-style=absolute > "$_cg_cache.tmp" 2>/dev/null \
      && mv -f "$_cg_cache.tmp" "$_cg_cache" 2>/dev/null \
      && printf '%s\n' "$_cg_key" > "$_cg_cache.key.tmp" 2>/dev/null \
      && mv -f "$_cg_cache.key.tmp" "$_cg_cache.key" 2>/dev/null; then
      _cg_fresh=1
    else
      rm -f "$_cg_cache.tmp" "$_cg_cache.key.tmp" 2>/dev/null
    fi
  fi
  # Exact whole-line match: a prefix match would claim files that merely live under a
  # managed directory, and chezmoi manages directories as entries in their own right.
  [ -n "$_cg_fresh" ] && ! grep -qxF "$FILE" "$_cg_cache" 2>/dev/null && exit 0
fi

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
