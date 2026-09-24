# shellcheck shell=bash
# chezmoi_managed_skip: one cached copy of `chezmoi managed`, shared by chezmoi-edit-guard.sh
# (PreToolUse) and chezmoi-guard.sh (PostToolUse), so both agree on what counts as managed
# and neither starts chezmoi when the other already has (#613).
#
# Why a cache at all: starting chezmoi costs ~41ms and both hooks run around every Edit and
# Write (~900/day), while the overwhelming majority of those edits are to files chezmoi has
# never managed. Caching the managed set turns that question into a string match.
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
# Knobs: CHEZMOI_GUARD_SOURCE_DIR points the key at another source dir. With no such
# directory there is nothing to key on, so every call asks chezmoi. CHEZMOI_GUARD_CACHE=0
# turns the cache off for both hooks.
#
# Usage: chezmoi_managed_skip "$FILE" && exit 0
#   Returns 0 only when a valid cache says FILE is not managed. Returns 1 whenever the
#   caller must ask chezmoi: FILE is listed, the cache is off, or the refresh failed.

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
    # never write into the same file.
    if { printf '%s\n' "$key" && chezmoi managed --path-style=absolute; } > "$cache.$$" 2>/dev/null \
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
