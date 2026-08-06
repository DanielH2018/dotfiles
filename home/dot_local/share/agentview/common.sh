# shellcheck shell=bash disable=SC2034
# agentview · common — helpers shared by more than one module: the pane cwd->title map
# and the Windows daemon roster. Kept separate so a mode that needs one of them does not
# drag in the whole focus or rows module. Sourced by ~/.local/bin/agentview.

PANELIST=""
# Pure-bash cwd normalizer mirroring the jq `norm` above (strip file://, \->/,
# drop the leading slash before a drive letter, trim trailing /, downcase). Lets
# title lookups run without a jq process per row.
norm_bash() {  # sets _norm (no $() subshell per call — forks are slow on Windows)
  local s="${1#file://}"; s="${s//\\//}"
  case "$s" in /[A-Za-z]:*) s="${s#/}";; esac
  s="${s%/}"; _norm="${s,,}"
}
# Build the cwd->title map ONCE from the mux snapshot (one jq call for the whole
# render) instead of one jq per row. Non-shell panes only, as normalized-cwd<TAB>title.
TCWDS=(); TTITLES=()
load_titles() {
  local line c t
  while IFS= read -r line; do
    # Split on the first tab by parameter expansion — `IFS=$'\t' read` collapses an EMPTY
    # leading field (tab is IFS whitespace), so a cwd-less pane would land its title in c
    # and poison the map. Same fix build_pretty's row parser already carries.
    c="${line%%$'\t'*}"
    if [ "$c" = "$line" ]; then t=""; else t="${line#*$'\t'}"; fi
    [ -z "$c" ] && continue; TCWDS+=("$c"); TTITLES+=("$t")
  done < <(printf '%s' "$PANELIST" | MSYS_NO_PATHCONV=1 jq -r "
      $JQ_NORM
      .[] | select($JQ_NONSHELL) | [(.cwd|norm), .title] | @tsv" 2>/dev/null)
}
title_for_cwd() {  # $1 = cwd -> sets _title to the Claude pane title at that cwd (or "")
  # Same cwd-match + non-shell filter as resolve_key, resolved against the prebuilt
  # map — no jq and no subshell per call.
  _title=""; norm_bash "$1"; local w="$_norm"; [ -z "$w" ] && return
  local i c
  for i in "${!TCWDS[@]}"; do
    c="${TCWDS[$i]}"
    if [ "$c" = "$w" ] || [[ "$w" == "$c"* ]] || [[ "$c" == "$w"* ]]; then
      _title="${TTITLES[$i]}"; return
    fi
  done
}
# Claude Code puts its state in the FIRST rune of the OSC title: a braille spinner frame
# (U+2800..U+28FF) while a turn runs, ✳ (U+2733) once it is ready for input. The rest of the
# title is the session name, and other writers own that too — a `claude agents` pane titles
# itself, a rename replaces the name outright — so a title with no glyph carries NO signal
# and must never be read as "not working".
# Matched as literal UTF-8 byte prefixes, not a character range, so the answer does not
# depend on the caller's locale (verified identical under LC_ALL=C and en_US.UTF-8). ✳ can
# demand the trailing space herdr's manifest does; braille cannot, because its third byte
# varies per frame and a glob `?` matches a character rather than a byte.
state_from_title() {  # $1 = title -> _tstate = working|idle|"" (never blocked); _tname = title minus the glyph
  _tstate=""; _tname="$1"
  case "$1" in
    $'\xe2\xa0'*|$'\xe2\xa1'*|$'\xe2\xa2'*|$'\xe2\xa3'*) _tstate="working" ;;
    $'\xe2\x9c\xb3 '*)                                   _tstate="idle" ;;
  esac
  # The glyph is always followed by a space, so this strips exactly it and nothing else.
  [[ -n "$_tstate" ]] && _tname="${1#* }"
}
win_roster() {  # echo the Windows daemon's roster as a JSON array; nonzero when we cannot ask.
  # `agents --json` is documented as printing "active sessions (interactive and background)",
  # which makes it the one oracle that can see a Windows session WSL has no checkable pid for.
  # Failure MUST stay distinguishable from an empty array — win_agent_live and reap_windows_rows
  # both refuse to act on "unknown". Costs ~0.7s (a Windows process spawn), so never call this
  # from a render path; --refresh-remote is where it belongs.
  # Memoized for the life of the process, since --refresh-remote now asks twice (reap, then
  # sync) and would otherwise pay that ~0.7s twice over. Only a SUCCESSFUL answer is cached: a
  # failure has to stay retryable, and every caller runs in a short-lived process, so a cached
  # roster cannot outlive the single command that fetched it.
  local out
  [ -n "${_win_roster_memo:-}" ] && { printf '%s' "$_win_roster_memo"; return 0; }
  [ -x "$WIN_CLAUDE" ] || return 1
  out=$("$WIN_CLAUDE" agents --json 2>/dev/null) || return 1
  printf '%s' "$out" | jq -e 'type == "array"' >/dev/null 2>&1 || return 1
  _win_roster_memo=$out
  printf '%s' "$out"
}

# Control sockets for the multiplexed ssh below. Under $HOME deliberately: a /mnt default
# would be a new absolute seam, and tests/agentview/agentview-seams.test.js fails on one that
# the shared helper does not cover.
AV_SSH_CTLDIR="${AGENT_VIEW_SSH_CTLDIR:-$HOME/.ssh/agentview}"
declare -a AV_SSH_OPTS=()

av_ssh_opts() {  # populate AV_SSH_OPTS; callers splat "${AV_SSH_OPTS[@]}" into their ssh call
  # %C is a hash of (host, port, user, address) rather than %r@%h:%p spelled out. Unix socket
  # paths cap at ~104 bytes and the literal form overflows it on long hostnames, at which
  # point ssh silently declines to multiplex and every call pays a full handshake again.
  mkdir -p "$AV_SSH_CTLDIR" 2>/dev/null || true
  chmod 700 "$AV_SSH_CTLDIR" 2>/dev/null || true
  # ConnectTimeout bounds the initial TCP handshake when establishing a NEW connection.
  # ServerAliveInterval + ServerAliveCountMax detect a stalled read against an already-
  # established ControlPersist master whose peer has gone away. They are NOT redundant:
  # losing either reopens a hang where the picker's background refresh blocks for minutes
  # on the OS TCP timeout instead of failing in ~10s.
  AV_SSH_OPTS=(
    -o ControlMaster=auto
    -o "ControlPath=$AV_SSH_CTLDIR/%C"
    -o ControlPersist=300
    -o ConnectTimeout=3
    -o ServerAliveInterval=5
    -o ServerAliveCountMax=2
  )
}

declare AV_SSH_OPTS_STR=""
av_ssh_opts_str() {  # flatten AV_SSH_OPTS for embedding in a command STRING (tmux new-window)
  # An array cannot be splatted into a string argument, and these options reach ssh through
  # tmux's shell, so each one is quoted rather than pasted raw.
  local o
  av_ssh_opts
  AV_SSH_OPTS_STR=""
  for o in "${AV_SSH_OPTS[@]}"; do AV_SSH_OPTS_STR+="$(printf '%q ' "$o")"; done
}

# One cache per host. A single shared file meant the last host to finish a refresh decided
# what every other host's rows looked like -- an unreachable host blanked a healthy one.
# Kept out of $statedir and without a .json suffix so the local session glob never sees them.
remote_cache_for()  { printf '%s/.agentview-remote-cache.%s' "$HOME" "$1"; }

# Sidecar, not a line inside the cache: three consumers run jq straight over the cache as
# JSONL (rows.sh, render.sh, actions.sh) and a metadata row would break all three.
# Format is one line -- "<outcome>\t<epoch>" -- with outcome in ok|unreachable|failed.
remote_status_for() { printf '%s/.agentview-remote-status.%s' "$HOME" "$1"; }

remote_hosts() { printf '%s\n' "${!HOST_SSH[@]}"; }

# Seen identity for the DONE group: $1=host $2=cwd $3=kind -> _sid.
# Deliberately NOT compute_pin_id (executable_agentview), which prefers the locator. A pin
# names a PANE, and a pane dying is exactly when a daemon-hosted job finishes — a pane-keyed
# marker would evaporate at the one moment this exists for. host+cwd+kind survives that, and
# matches how the rest of agentview keys a session. Lives here rather than beside
# compute_pin_id so fold_seen_states can be exercised by sourcing the libs alone.
compute_seen_id() { _sid="$1$US$2$US$3"; }
