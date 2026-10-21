# shellcheck shell=bash
# Shared state for the artifact hooks. Most of it serves the auto-refresh pair:
# link-artifact.sh registers the artifact a project is tracking, artifact-refresh.sh
# reads it back at Stop. The star list and the host label at the end serve the
# artifact browser (serve-artifacts.sh) and the sweep (prune-artifacts.sh).
#
# Two keys, because the two halves of the state have different lifetimes.
#
# WHICH doc is tracked is keyed on the repository. A doc covering three slices of
# work outlives the session that wrote it, and the later slices often land from a
# different worktree than the one that wrote the plan — a worktree-only key would go
# silent on day two, exactly when those slices land. A worktree that writes its own
# artifact still gets its own entry, which wins over the repo one.
#
# WHOSE commits landed is keyed on the worktree. Several sessions work this repo at
# once, so an upstream-wide diff shows every other session's commits alongside yours.
# The worktree is the unit of one session's work, so that is the unit the pending
# list is scoped to.

# DECIDED: the git calls in this library run without run_bounded (#661). They read local
# refs only (rev-parse, symbolic-ref; no fetch, no network) and never walk the working
# tree. A bound would add a tempfile and a timeout(1) fork to each for a hang no one has
# seen, in the three artifact hooks that source this file. Those hooks are recorders whose
# failure costs a missed nudge, not guards.

# shellcheck disable=SC2034  # read by the hooks that source this
ARTIFACT_STATE_DIR="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"

artifact_hash_dir() {
  local d
  d=$(readlink -f "$1" 2>/dev/null) || return 1
  [[ -n "$d" ]] || return 1
  printf '%s' "$d" | sha1sum | cut -c1-16
}

# The primary checkout's git dir — shared by every worktree of the repo.
artifact_repo_slug() {
  local common
  common=$(git rev-parse --git-common-dir 2>/dev/null) || return 1
  [[ -n "$common" ]] || return 1
  artifact_hash_dir "$common"
}

# This worktree's own git dir: `.git` in the primary checkout, `.git/worktrees/<name>`
# in a linked worktree, so the two never collide.
artifact_worktree_slug() {
  local dir
  dir=$(git rev-parse --git-dir 2>/dev/null) || return 1
  [[ -n "$dir" ]] || return 1
  artifact_hash_dir "$dir"
}

# Several sessions commonly share one worktree too -- most agents here work directly
# in the primary checkout (EnterWorktree is opt-in), so artifact_worktree_slug alone
# is not enough: two unrelated sessions in the same checkout hash to the same key and
# read/write the same pending file, so one session's landed commits get reported to
# the other as if they were its own. Folding session_id into the key gives each
# session its own pending/baseline files even when the worktree slug is identical.
# Falls back to the bare worktree slug when no session_id is available (older hook
# payloads), which reproduces the pre-fix behavior rather than going silent.
artifact_session_key() {
  local wt="$1" sess="${2:-}"
  [[ -n "$wt" ]] || return 1
  if [[ -z "$sess" ]]; then
    printf '%s' "$wt"
    return 0
  fi
  printf '%s:%s' "$wt" "$sess" | sha1sum | cut -c1-16
}

# Not every repo here is `main` — the homelab server's default branch is master — so
# ask the remote what its HEAD is before falling back to guessing.
artifact_upstream_ref() {
  local head ref
  head=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)
  if [[ -n "$head" ]]; then
    printf '%s' "$head"
    return 0
  fi
  for ref in refs/remotes/origin/main refs/remotes/origin/master; do
    if git rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
      printf '%s' "$ref"
      return 0
    fi
  done
  return 1
}

# The star list: one `<host>/<relpath>` line per artifact the browser has starred, which
# prune-artifacts.sh never deletes. Kept out of the artifacts dir and out of
# ARTIFACT_STATE_DIR, because both are swept by mtime and a list nobody touched for a month
# would be deleted with them. The k3s nodes set CLAUDE_ARTIFACT_STARS_FILE in
# settings.base.json; a workstation's loopback browser owns the default path.
ARTIFACT_STARS_FILE="${CLAUDE_ARTIFACT_STARS_FILE:-$HOME/.claude/artifact-stars.txt}"

# The label this host's own tree carries: the /a/<host>/ segment the browser serves it
# under, and the prefix of this host's lines in the star list. The browser and the sweep
# must agree on it, or a star set in one is invisible to the other. On macOS, `hostname`
# can follow a DHCP-supplied name, so LocalHostName comes first; it changes only when
# someone renames the machine.
#
# scutil is called by absolute path, so the label does not depend on /usr/sbin being on
# PATH in whatever environment Claude Code was started from. ARTIFACT_SCUTIL exists for
# the tests.
#
# Inside Claude Code's Bash sandbox (Seatbelt), scutil can print a different
# LocalHostName from the one it prints outside. On one laptop on 2026-10-21 it printed
# MacBook-Pro sandboxed and MacBook-Pro-2 unsandboxed. The hooks run unsandboxed, so the
# browser, the sweep and the star list all carry the unsandboxed name. Do not run
# prune-artifacts.sh from a sandboxed shell: under the other label it matches no star
# and deletes starred artifacts.
artifact_host_label() {
  local host="${CLAUDE_ARTIFACTS_HOST:-}"
  if [[ -z "$host" && "$(uname -s)" == Darwin ]]; then
    host=$("${ARTIFACT_SCUTIL:-/usr/sbin/scutil}" --get LocalHostName 2>/dev/null)
  fi
  printf '%s' "${host:-$(hostname -s 2>/dev/null || echo local)}"
}

# The browser's root: one symlink to this host's tree, named for the label the browser
# publishes under /a/<host>/. serve-artifacts.sh writes it, so its name is the label the
# star list's lines for this host were written under.
ARTIFACT_SERVER_ROOT="$HOME/.claude/.artifacts-root"

# Moves this host's star lines from any label the browser published before to the
# current one, so a label change does not release every star at the next sweep. The old
# labels are the root's other symlinks. Lines for other hosts are left as they are, and
# a line that already exists under the new label is not duplicated.
#
# Does nothing where the list is read-only to this host (CLAUDE_ARTIFACTS_BASE_URL: the
# cluster's browser owns it) or cannot be read and rewritten. Call it before anything
# reads the list for this host: prune-artifacts.sh runs before serve-artifacts.sh at
# session start.
artifact_migrate_stars() {
  local host="$1" stars="$ARTIFACT_STARS_FILE" old olds=() tmp
  [[ -n "${CLAUDE_ARTIFACTS_BASE_URL:-}" ]] && return 0
  [[ -f "$stars" && -r "$stars" && -w "$stars" && -w "${stars%/*}" ]] || return 0
  [[ -d "$ARTIFACT_SERVER_ROOT" ]] || return 0
  while IFS= read -r -d '' old; do
    old="${old##*/}"
    [[ "$old" != "$host" ]] && olds+=("$old")
  done < <(find "$ARTIFACT_SERVER_ROOT" -mindepth 1 -maxdepth 1 -type l -print0 2>/dev/null)
  ((${#olds[@]})) || return 0
  # A temp file beside the list and a rename, the way the browser's StarStore writes it,
  # so a reader never sees half a list.
  tmp=$(mktemp "${stars%/*}/.stars.XXXXXX") || return 0
  if awk -v host="$host" -v olds="$(printf '%s\n' "${olds[@]}")" '
    BEGIN { n = split(olds, o, "\n"); for (i = 1; i <= n; i++) if (o[i] != "") old[o[i]] = 1 }
    {
      line = $0
      slash = index(line, "/")
      if (slash > 1 && (substr(line, 1, slash - 1) in old)) line = host substr(line, slash)
      if (!(line in seen)) { seen[line] = 1; print line }
    }' "$stars" >"$tmp"; then
    cmp -s "$tmp" "$stars" || { chmod 644 "$tmp" && mv -f "$tmp" "$stars"; }
  fi
  rm -f "$tmp"
}
