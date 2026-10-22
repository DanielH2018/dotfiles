#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 15
#   order: 50
#   statusMessage: Syncing chezmoi source...
#   when: not (includeTemplate "is-agent" .)
# gen-hooks: register
#   event: PreToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 10
#   order: 55
#   args: pre
# chezmoi-guard.sh — keep edits to chezmoi-managed files from being silently reverted by the
# next `chezmoi apply`. One script, two registrations, the same shape as chezmoi-apply-guard.sh.
#
# The PostToolUse registration comes first, and it is the no-argument default, because
# bash-write-fanout.sh re-drives this file with no argument and reads its first `timeout:`
# line as the bound to give it. Both must keep meaning the post side.
#
# post (PostToolUse, the default): keep the chezmoi source in sync with an edit to a deployed
# file.
#
#   - plain managed file        -> `chezmoi add` re-syncs the source automatically
#   - templated/scripted source -> warn only (the rendered output must not
#     overwrite its .tmpl / modify_ / create_ / run_ / symlink_ source)
#   - unmanaged file            -> no-op
#
#   Re-syncing only updates the source working tree; committing in ~/.local/share/chezmoi
#   stays a manual, reviewable step.
#
# pre (PreToolUse): refuse an edit to a deployed file whose chezmoi source is a template or a
# script, and name the source to edit instead (#574). A .tmpl / modify_ / run_ source cannot
# take the post side's `chezmoi add`, because the deployed bytes are its OUTPUT, so the post
# side can only warn after the edit has landed. Deciding before the edit turns that warning
# into a pointer at the right file.
#
#   .tmpl, modify_, run_ source   deny, printing the source path
#   ~/.claude/settings.json       deny, naming settings.base.json (its modify_ script merges
#                                 that template with the work overlay)
#   plain managed file            no decision; the post side re-syncs it afterwards
#   create_, symlink_ source      no decision; apply does not revert those
#   unmanaged file                no decision
#
#   Override for a deliberate throwaway edit: start the session with CHEZMOI_EDIT_GUARD=off.
#
# Failure contracts. No chezmoi and no jq are no decision on both sides: with no chezmoi
# nothing is managed. A source-path that exits non-zero is an unmanaged file, also no
# decision. A lookup that could not finish is different (#657). Every chezmoi call runs
# through run_bounded (#581), and one that times out, is killed, or cannot start says
# nothing about whether the file is managed. The pre side asks, naming what did not finish,
# and the post side reports it as not evaluated. A missing run-bounded.sh takes the same
# path, because the lookup cannot run bounded, so it does not run.

set -u

MODE=${1:-post}
command -v chezmoi >/dev/null 2>&1 || exit 0
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/lib/hook-input.sh}"
hook_read_input
# After the read, not before: a hook that exits with its stdin unread can hand the writer
# an EPIPE, which the test runner reports as a failure under load.
[ "$MODE" = pre ] && [ "${CHEZMOI_EDIT_GUARD:-}" = "off" ] && exit 0
hook_require_jq noop || exit 0

FILE=$(hook_field '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -n "$FILE" ] || exit 0

# Windows: Claude Code passes paths as C:/Users/... but $HOME is the MSYS form
# /c/Users/... ; normalize so the $HOME-prefixed matching below works. cygpath is
# absent on macOS/Linux, so this is a no-op there and native paths are untouched.
if command -v cygpath >/dev/null 2>&1; then
  FILE=$(cygpath -u "$FILE" 2>/dev/null || printf '%s' "$FILE")
fi

# chezmoi targets live under $HOME; skip everything else cheaply. The source tree
# (worktrees included) is where an edit belongs, and the other two are hot paths chezmoi
# never manages.
case "$FILE" in
  "$HOME"/*) ;;
  *) exit 0 ;;
esac
case "$FILE" in
  "$HOME"/.local/share/chezmoi/*|"$HOME"/Repositories/*|"$HOME"/Documents/*) exit 0 ;;
esac
[ "$MODE" = pre ] && case "$FILE" in */.claude/worktrees/*) exit 0 ;; esac

# The way each side reports a check it could not complete: the pre side stops the edit for
# a human, the post side tells the model the file may be left unsynced.
not_evaluated() {
  if [ "$MODE" = pre ]; then
    hook_ask "chezmoi-guard: $1 -- not evaluated, so it is unknown whether $FILE is rendered from a template or script source. If it is, a hand edit is reverted by the next \`chezmoi apply\`: check with \`chezmoi source-path $FILE\`. Starting the session with CHEZMOI_EDIT_GUARD=off turns this guard off."
  else
    emit "chezmoi-guard: $1 -- not evaluated. $2"
  fi
  exit 0
}

emit() {
  jq -n --arg msg "$1" '{
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $msg }
  }'
}

# The bounds share each registration's timeout. Pre (10s): 2s for `chezmoi managed` below,
# then 3s for source-path. Post (15s): the same 2s, then 3s for source-path, 7s for add and
# 2s for chattr. CHEZMOI_EDIT_GUARD_TIMEOUT_S and CHEZMOI_GUARD_TIMEOUT_S set the pre and
# post side's own bounds, for the tests.
#
# A missing library is reported rather than run around: this file may be managed, and if it
# is, the next apply reverts the edit unless someone re-syncs it.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/lib/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  not_evaluated "cannot load $RUN_BOUNDED_PATH, so chezmoi was not asked" \
    "If $FILE is managed, run \`chezmoi add $FILE\`."
fi
if [ "$MODE" = pre ]; then
  T_LOOKUP=${CHEZMOI_EDIT_GUARD_TIMEOUT_S:-3}
else
  T_LOOKUP=${CHEZMOI_GUARD_TIMEOUT_S:-3}
fi
T_ADD=${CHEZMOI_GUARD_TIMEOUT_S:-7}
T_CHATTR=${CHEZMOI_GUARD_TIMEOUT_S:-2}

#######################################
# Whether a valid cached copy of `chezmoi managed` says a file is NOT managed (#613).
#
# Why a cache at all: starting chezmoi costs ~41ms and both sides run around every Edit and
# Write (~900/day), while the overwhelming majority of those edits are to files chezmoi has
# never managed. Caching the managed set turns that question into a string match, and the
# pre side's refresh serves the post side's lookup for the same edit.
#
# The cache is used ONLY to skip. A path absent from the cache skips; a path present falls
# through to the caller's `chezmoi source-path` call, which stays the authority. That
# asymmetry makes a stale cache safe in one direction: a file that has STOPPED being managed
# still reaches source-path, which fails, and the hook exits as it always did.
#
# The direction that is not free is a file that BECOMES managed, so the cache is keyed on
# its inputs rather than on its age (#579): a cksum of every path in the source tree, the
# contents of its .chezmoi* control files, and the chezmoi config. `chezmoi add`, a new
# .chezmoiignore line, a branch switch and a config edit all change the key, and the next
# call refetches. File contents outside the .chezmoi* files are left out: they decide what
# a target renders to, not whether it is managed. Measured 2026-09-23 against this repo's
# source, the key takes ~13ms, against ~34ms for `chezmoi managed`.
#
# The key and the list share one file, the key on line 1, written by a single rename. Two
# files renamed one after the other let a concurrent writer pair its key with another
# writer's list. The key line starts with `key:`, so it never equals an absolute path.
#
# The refresh runs `chezmoi managed` through run_bounded (#581, #657). A refresh cut off by
# the bound, or by the byte cap, leaves the cache alone: a truncated list would make every
# path past the cut read as unmanaged, which is the unsafe direction.
#
# Globals:
#   CHEZMOI_GUARD_SOURCE_DIR  points the key at another source dir. With no such directory
#                             there is nothing to key on, so every call asks chezmoi.
#   CHEZMOI_GUARD_CACHE       0 turns the cache off.
#   CHEZMOI_MANAGED_TIMEOUT_S the refresh bound, 2s by default; `chezmoi managed` answered
#                             in ~34ms when measured.
# Arguments:
#   The absolute target path.
# Returns:
#   0 only when a valid cache says the file is not managed. 1 whenever the caller must ask
#   chezmoi: the file is listed, the cache is off, or the refresh failed.
#######################################
chezmoi_managed_skip() {
  local file="$1" src root sub key old cache fresh=''
  [ "${CHEZMOI_GUARD_CACHE:-1}" != 0 ] || return 1
  src="${CHEZMOI_GUARD_SOURCE_DIR:-$HOME/.local/share/chezmoi}"
  [ -d "$src" ] || return 1
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/claude-hooks/chezmoi-managed"

  # Walk the tree chezmoi reads: the .chezmoiroot subdirectory when there is one, so an edit
  # to repo tooling beside it (bin/, tests/) is not a miss. .chezmoiroot itself is in the key.
  root="$src"
  if [ -f "$src/.chezmoiroot" ]; then
    sub=''
    IFS= read -r sub < "$src/.chezmoiroot" 2>/dev/null
    [ -n "$sub" ] && [ -d "$src/$sub" ] && root="$src/$sub"
  fi
  # Two walks rather than one: interleaving -print with an -exec'd cat would leave the
  # order of the two streams to buffering, and a key that varies between identical trees
  # never hits. .git and the worktrees under .claude are not source state.
  key="key:$( {
    cat "$src/.chezmoiroot"
    find "$root" \( -path "$root/.git" -o -path "$root/.claude" \) -prune -o -print
    find "$root" \( -path "$root/.git" -o -path "$root/.claude" \) -prune -o \
      -type f -name '.chezmoi*' -exec cat {} +
    cat "${XDG_CONFIG_HOME:-$HOME/.config}"/chezmoi/chezmoi.*
  } 2>/dev/null | cksum)"

  # An empty list after the key line is a legitimate answer: "chezmoi manages nothing here".
  if [ -f "$cache" ]; then
    old=''
    IFS= read -r old < "$cache" 2>/dev/null
    [ "$old" = "$key" ] && fresh=1
  fi
  if [ -z "$fresh" ]; then
    mkdir -p "${cache%/*}" 2>/dev/null
    # Exit status is the only signal that separates "nothing is managed" from "the query
    # failed". A failed refresh leaves the old cache alone, and its stale key sends this
    # call and the next to chezmoi. The temp name carries the PID so parallel sessions
    # never write into the same file. chezmoi's stderr is dropped inside the child, since
    # run_bounded merges the two streams and a warning line would read as a managed path.
    # The 4 MiB cap is ~100x this machine's list (38868 bytes, 768 paths, 2026-09-24).
    run_bounded "${CHEZMOI_MANAGED_TIMEOUT_S:-2}" 4194304 -- \
      bash -c 'exec chezmoi managed --path-style=absolute 2>/dev/null'
    if [ "$RB_STATUS" = ok ] && [ "$RB_EXIT" -eq 0 ] \
      && { printf '%s\n' "$key"; [ -z "$RB_OUT" ] || printf '%s\n' "$RB_OUT"; } > "$cache.$$" 2>/dev/null \
      && mv -f "$cache.$$" "$cache" 2>/dev/null; then
      fresh=1
    else
      rm -f "$cache.$$" 2>/dev/null
    fi
  fi
  # Exact whole-line match: a prefix match would claim files that merely live under a
  # managed directory, and chezmoi manages directories as entries in their own right.
  [ -n "$fresh" ] && ! grep -qxF "$file" "$cache" 2>/dev/null
}

chezmoi_managed_skip "$FILE" && exit 0

# source-path exits non-zero when the file isn't managed by chezmoi. Its stderr is dropped
# inside the child, because run_bounded merges the two streams and SRC must be the path alone.
# shellcheck disable=SC2016  # $1 belongs to the inner bash
run_bounded "$T_LOOKUP" 65536 -- bash -c 'exec chezmoi source-path "$1" 2>/dev/null' _ "$FILE"
if [ "$RB_STATUS" != ok ]; then
  not_evaluated "\`chezmoi source-path\` did not answer within ${T_LOOKUP}s ($RB_STATUS)" \
    "It is unknown whether $FILE is managed. Check \`chezmoi status\`."
fi
[ "$RB_EXIT" -eq 0 ] || exit 0
SRC=$RB_OUT
[ -n "$SRC" ] || exit 0

if [ "$MODE" = pre ]; then
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
  hook_deny "$REASON"
  exit 0
fi

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
