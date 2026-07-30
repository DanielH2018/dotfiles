# shellcheck shell=bash
# Prove a recorded pid still denotes the process that was recorded, before anything
# signals it.
#
# A pid on its own is not an identity: Linux recycles them. ~/.claude/sessions/<pid>.json
# already stores `procStart` — /proc/<pid>/stat field 22, the process start time in clock
# ticks since boot — and the pair (pid, procStart) is stable for a process's lifetime and
# never reused. Comparing the pair is what makes signalling safe; comparing the pid alone
# is how a stale registry entry aims a SIGTERM at whatever now holds that number.
#
# Verdicts are deliberately four, not three. Collapsing "cannot tell" into live/dead is
# the fallback this library exists to remove, so `unverifiable` is distinct and, like
# `dead` and `different`, returns non-zero — only `live` returns 0.
#
# Test seam (default is the real thing): IDENTITY_PROC_DIR.

# proc_start_of <pid>
#   Print a running pid's start time, or nothing if it cannot be read.
#   Reached by cutting past the LAST ')' rather than counting fields from the left: the
#   comm field is parenthesised and may itself contain spaces and parens, so a plain
#   `awk '{print $22}'` misreads every process whose name has a space in it.
proc_start_of() {
  local pid="$1" procdir="${IDENTITY_PROC_DIR:-/proc}" line
  [[ -n "$pid" && "$pid" != *[!0-9]* ]] || return 1
  read -r line <"$procdir/$pid/stat" 2>/dev/null || return 1
  local -a fields
  read -r -a fields <<<"${line##*') '}"
  [[ -n "${fields[19]:-}" ]] || return 1
  printf '%s\n' "${fields[19]}"
}

# verify_target <pid> <recorded_start>
#   Print one of live | dead | different | unverifiable. Returns 0 only for live.
verify_target() {
  local pid="$1" recorded="$2" procdir="${IDENTITY_PROC_DIR:-/proc}" actual

  if [[ -z "$pid" || "$pid" == *[!0-9]* ]]; then
    printf 'unverifiable\n'
    return 1
  fi

  if ! actual=$(proc_start_of "$pid"); then
    # A missing /proc entry is unambiguous; an entry we cannot parse is not.
    if [[ -d "$procdir/$pid" ]]; then
      printf 'unverifiable\n'
    else
      printf 'dead\n'
    fi
    return 1
  fi

  if [[ -z "$recorded" ]]; then
    printf 'unverifiable\n'
    return 1
  fi

  if [[ "$actual" == "$recorded" ]]; then
    printf 'live\n'
    return 0
  fi

  printf 'different\n'
  return 1
}

# verify_session_pid <sessions_dir> <sid>
#   Print the pid of the one live process recorded for <sid>, or nothing.
#   Every record naming the sid is examined rather than stopping at the first: duplicate
#   sessionId entries accumulate as pids are recycled, and the first match encountered on
#   disk is as likely to be the stale one as the live one. Two live processes claiming the
#   same session id is a state this cannot resolve safely, so it refuses.
verify_session_pid() {
  local sessions_dir="$1" sid="$2"
  [[ -n "$sid" ]] || return 1

  local pf pid recorded found="" live=0
  shopt -s nullglob
  for pf in "$sessions_dir"/*.json; do
    [[ "$(jq -r '.sessionId // ""' "$pf" 2>/dev/null)" == "$sid" ]] || continue
    pid=$(jq -r '.pid // ""' "$pf" 2>/dev/null)
    recorded=$(jq -r '.procStart // ""' "$pf" 2>/dev/null)
    [[ "$(verify_target "$pid" "$recorded")" == "live" ]] || continue
    found="$pid"
    live=$((live + 1))
  done
  shopt -u nullglob

  [[ "$live" -eq 1 ]] || return 1
  printf '%s\n' "$found"
}
