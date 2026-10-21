# shellcheck shell=bash
# Shared state for the artifact hooks: where they keep their state, the repository each
# artifact was written from, the star list, and this host's label. link-artifact.sh records
# the repository; the artifact browser (serve-artifacts.sh) and the sweep
# (prune-artifacts.sh) read the rest.

# shellcheck disable=SC2034  # read by the hooks that source this
ARTIFACT_STATE_DIR="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"
# One `<artifact relpath>\t<repo name>` line per repo change: link-artifact.sh appends,
# serve-artifacts.sh hands the path to the browser, which filters by it.
# shellcheck disable=SC2034
ARTIFACT_REPOS_FILE="$ARTIFACT_STATE_DIR/repos.tsv"

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
