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
#   + seed.intent="(backgrounded)", where launch.sessionId is the origin transcript path.
#   A plain spare-spawned agent (source=spare, mode=prompt, intent="") never matches.
#
# Test seams (defaults are the real thing): CLAUDE_SESSIONS_DIR, AGENT_VIEW_DIR,
# REAP_KILLCMD, REAP_LOG, REAP_ROSTER, IDENTITY_LIB.

# Pid-reuse verification, so the signal below can only reach the recorded process.
# shellcheck source=/dev/null
. "${IDENTITY_LIB:-${BASH_SOURCE[0]%/*}/identity.sh}"

# _reap_origin_sid <origin_sid> <fork_sid>
#   Resolve the origin session id to a live pid and SIGTERM it. Never self, graceful only.
#   Returns 0 if it reaped, 1 otherwise.
_reap_origin_sid() {
  local origin_sid="$1" fork_sid="$2"
  local sessions_dir="${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"
  local av_dir="${AGENT_VIEW_DIR:-$HOME/.claude/agent-view}"
  local killcmd="${REAP_KILLCMD:-kill}"
  local logfile="${REAP_LOG:-$HOME/.local/state/reap-origin.log}"

  # guard: non-empty and never self
  [ -n "$origin_sid" ] || return 1
  [ "$origin_sid" != "$fork_sid" ] || return 1

  # Resolve the origin session id to a pid that is still the process we recorded.
  # verify_session_pid checks every record naming the sid and compares each pid against
  # its stored procStart, so a recycled pid resolves to nothing rather than to whatever
  # now holds that number.
  local origin_pid
  origin_pid=$(verify_session_pid "$sessions_dir" "$origin_sid") || return 1
  [ -n "$origin_pid" ] || return 1

  # never signal ourselves
  [ "$origin_pid" != "$$" ] && [ "$origin_pid" != "$PPID" ] || return 1

  # SIGTERM (graceful): transcript stays on disk, resumable
  "$killcmd" "$origin_pid" 2>/dev/null

  # drop the Agentview row so it vanishes now instead of on the next dead-pid prune
  rm -f "$av_dir/$origin_sid.json" 2>/dev/null

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
  select(($d.seed.intent // "") == "(backgrounded)")  |
  ($d.launch.sessionId // "") as $p                   |
  select($p | endswith(".jsonl"))                     |
  (($p | split("/") | last | sub("\\.jsonl$"; "")) + "\t" + ($w.sessionId // ""))
' "$roster" 2>/dev/null)
EOF
  return $rc
}
