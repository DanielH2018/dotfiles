# shellcheck shell=bash
# Shared reaper logic for backgrounded-origin cleanup. Sourced by both the SessionStart
# hook (reap-backgrounded-origin.sh) and the periodic sweep (reap-backgrounded-origins-sweep).
# Keeping the safety-critical detection in ONE place means both paths reap on exactly the
# same signature and guards.
#
# reap_origin_from_cmdline <cmdline> <fork_sid>
#   Given the cmdline of a bg-fork worker and that fork's own session id, SIGTERM the
#   redundant interactive ORIGIN it was forked from — but ONLY on the exact three-flag
#   backgrounding signature, never self, graceful only. Returns 0 if it reaped, 1 otherwise.
#
# Test seams (defaults are the real thing): CLAUDE_SESSIONS_DIR, AGENT_VIEW_DIR,
# REAP_KILLCMD, REAP_LOG.
reap_origin_from_cmdline() {
  local cmdline="$1" fork_sid="$2"
  local sessions_dir="${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"
  local av_dir="${AGENT_VIEW_DIR:-$HOME/.claude/agent-view}"
  local killcmd="${REAP_KILLCMD:-kill}"
  local logfile="${REAP_LOG:-$HOME/.local/state/reap-origin.log}"

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

  # guard: non-empty and never self
  [ -n "$origin_sid" ] || return 1
  [ "$origin_sid" != "$fork_sid" ] || return 1

  # resolve origin pid pid-reuse-safely: the sessions/<pid>.json whose sessionId matches
  local pf origin_pid=""
  shopt -s nullglob
  for pf in "$sessions_dir"/*.json; do
    if [ "$(jq -r '.sessionId // ""' "$pf" 2>/dev/null)" = "$origin_sid" ]; then
      origin_pid=$(jq -r '.pid // ""' "$pf" 2>/dev/null)
      break
    fi
  done
  shopt -u nullglob
  [ -n "$origin_pid" ] || return 1

  # never signal ourselves / a non-numeric pid
  case "$origin_pid" in ''|*[!0-9]*) return 1;; esac
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
