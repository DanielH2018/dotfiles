# shellcheck shell=bash
# Shared reaper logic for backgrounded-origin cleanup. Sourced by both the SessionStart
# hook (reap-backgrounded-origin.sh) and the periodic sweep (reap-backgrounded-origins-sweep).
# Keeping the safety-critical detection in ONE place means both paths reap on exactly the
# same signature and guards.
#
# Two detection paths, both ending in _reap_origin_sid (same guards, same graceful kill):
#
# reap_origin_from_cmdline <cmdline> <fork_sid>
#   Given the cmdline of a bg-fork worker and that fork's own session id, SIGTERM the
#   redundant interactive ORIGIN it was forked from — but ONLY on the exact three-flag
#   backgrounding signature, never self, graceful only. Returns 0 if it reaped, 1 otherwise.
#
# reap_origin_from_roster [roster_file]
#   Claude Code >=2.1 dispatches a backgrounded session onto a pre-warmed spare, so the
#   worker argv is only `claude bg-spare --bg-spare <claim.sock>` — the --resume link to
#   the origin is gone from the cmdline and survives solely in the daemon roster. Same
#   three-marker rigor, read from dispatch instead: launch.mode=resume + launch.fork=true
#   + a non-empty seed.intent, where launch.sessionId is the origin transcript path.
#   A plain spare-spawned agent (source=spare, mode=prompt, intent="") never matches.
#
#   intent was originally required to equal the literal "(backgrounded)". That is what a
#   session backgrounded with no prompt carries — but backgrounding WITH a prompt puts the
#   prompt text there instead, so the gate silently excluded the commonest case and left the
#   origin alive holding ~430MB and a second Agentview row. Found live: a roster entry with
#   mode=resume, fork=true and the user's prompt as intent, whose origin was still running
#   1h53m later. The discrimination never rested on this marker anyway — mode=prompt and
#   fork=false already reject a plain spare — so it is now "some intent" rather than one
#   exact string.
#
# Test seams (defaults are the real thing): CLAUDE_SESSIONS_DIR, AGENT_VIEW_DIR,
# REAP_KILLCMD, REAP_LOG, REAP_ROSTER, IDENTITY_LIB.

# Pid-reuse verification, so the signal below can only reach the recorded process.
# shellcheck source=/dev/null
. "${IDENTITY_LIB:-${BASH_SOURCE[0]%/*}/identity.sh}"

# _reap_session_index
#   Populate _REAP_INDEX with one "<sessionId>\t<pid>\t<procStart>" line per
#   sessions/<pid>.json, using a single jq for the whole batch. Resolving an origin used to
#   fork a jq per session file, so a sweep over N sessions carrying M backgroundings cost
#   N*M forks — enough that the timer ran back-to-back at ~100% of a core and made a memory
#   crunch worse.
#
#   procStart rides along because a pid alone is not an identity: it is the third column so
#   the caller can verify a row without going back to disk, which would reintroduce the
#   per-row fork this function exists to remove.
#
#   Memoized for the process lifetime. Both callers are short-lived (one hook invocation, one
#   sweep), and a session file landing mid-run was already a race in either direction.
_REAP_INDEX=""
_REAP_INDEX_READY=""
_reap_session_index() {
  [ -n "$_REAP_INDEX_READY" ] && return 0
  _REAP_INDEX_READY=1

  local sessions_dir="${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"
  local files pf
  shopt -s nullglob
  files=("$sessions_dir"/*.json)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || return 0

  # jq aborts the whole batch on the first half-written file, so keep the per-file scan as a
  # fallback: slower, but a parse error stays isolated to the file that caused it.
  if _REAP_INDEX=$(jq -r '[.sessionId // "", .pid // "", .procStart // ""] | @tsv' "${files[@]}" 2>/dev/null); then
    return 0
  fi
  _REAP_INDEX=""
  for pf in "${files[@]}"; do
    _REAP_INDEX+="$(jq -r '[.sessionId // "", .pid // "", .procStart // ""] | @tsv' "$pf" 2>/dev/null)"$'\n'
  done
  return 0
}

# _reap_origin_sid <origin_sid> <fork_sid>
#   Resolve the origin session id to a live pid and SIGTERM it. Never self, graceful only.
#   Returns 0 if it reaped, 1 otherwise.
_reap_origin_sid() {
  local origin_sid="$1" fork_sid="$2"
  local killcmd="${REAP_KILLCMD:-kill}"
  local logfile="${REAP_LOG:-$HOME/.local/state/reap-origin.log}"

  # guard: non-empty and never self
  [ -n "$origin_sid" ] || return 1
  [ "$origin_sid" != "$fork_sid" ] || return 1

  # Resolve the origin session id to a pid that is still the process we recorded.
  # Every row naming the sid is checked rather than the first one found: duplicate
  # entries accumulate as pids are recycled, and the first match in the index is as
  # likely to be the stale one as the live one. Two rows that both verify live is a
  # state this cannot resolve safely, so it refuses rather than picking.
  local origin_pid="" isid ipid istart live=0
  _reap_session_index
  while IFS="$(printf '\t')" read -r isid ipid istart; do
    [ "$isid" = "$origin_sid" ] || continue
    [ "$(verify_target "$ipid" "$istart")" = "live" ] || continue
    origin_pid="$ipid"
    live=$((live + 1))
  done <<< "$_REAP_INDEX"
  [ "$live" -eq 1 ] || return 1
  [ -n "$origin_pid" ] || return 1

  # never signal ourselves
  [ "$origin_pid" != "$$" ] && [ "$origin_pid" != "$PPID" ] || return 1

  # SIGTERM (graceful): transcript stays on disk, resumable
  "$killcmd" "$origin_pid" 2>/dev/null

  # audit
  mkdir -p "$(dirname "$logfile")" 2>/dev/null
  printf '%s reaped origin %s pid=%s from fork %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$origin_sid" "$origin_pid" "${fork_sid:-?}" \
    >> "$logfile" 2>/dev/null
  return 0
}

reap_origin_from_cmdline() {
  local cmdline="$1" fork_sid="$2"

  # --- signature gate: all three markers, else no-op ---
  case " $cmdline " in *" --fork-session "*) ;; *) return 1;; esac
  case " $cmdline " in *" --reply-on-resume "*) ;; *) return 1;; esac
  case "$cmdline" in *"--resume "*) ;; *) return 1;; esac

  # origin sid = basename of the token after --resume, minus .jsonl
  local resume_path=""
  # shellcheck disable=SC2086  # deliberate word-split: tokenize the space-joined cmdline
  set -- $cmdline
  while [ $# -gt 0 ]; do
    if [ "$1" = "--resume" ]; then resume_path="${2:-}"; break; fi
    shift
  done
  case "$resume_path" in *.jsonl) ;; *) return 1;; esac
  local origin_sid="${resume_path##*/}"; origin_sid="${origin_sid%.jsonl}"

  _reap_origin_sid "$origin_sid" "$fork_sid"
}

reap_origin_from_roster() {
  local roster="${1:-${REAP_ROSTER:-$HOME/.claude/daemon/roster.json}}"
  [ -r "$roster" ] || return 1

  # dispatch gate mirrors the cmdline one: all three markers, else the entry is skipped.
  local origin_sid fork_sid rc=1
  while IFS="$(printf '\t')" read -r origin_sid fork_sid; do
    [ -n "$origin_sid" ] || continue
    _reap_origin_sid "$origin_sid" "$fork_sid" && rc=0
  done <<EOF
$(jq -r '
  (.workers // {}) | to_entries[] | .value as $w | ($w.dispatch // {}) as $d |
  select(($d.launch.mode // "")  == "resume")         |
  select(($d.launch.fork // false) == true)           |
  select((($d.seed.intent // "") | length) > 0)       |
  ($d.launch.sessionId // "") as $p                   |
  select($p | endswith(".jsonl"))                     |
  (($p | split("/") | last | sub("\\.jsonl$"; "")) + "\t" + ($w.sessionId // ""))
' "$roster" 2>/dev/null)
EOF
  return $rc
}
