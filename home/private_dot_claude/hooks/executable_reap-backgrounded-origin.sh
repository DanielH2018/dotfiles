#!/usr/bin/env bash
# SessionStart hook. When Claude Code backgrounds a session it forks a daemon
# (--fork-session --resume <origin>.jsonl --reply-on-resume) but leaves the interactive
# ORIGIN process alive, holding ~430MB and cluttering Agentview. This hook runs at the
# daemon's SessionStart (source=startup for daemon jobs), detects that exact signature in
# the ancestor Claude cmdline, and SIGTERMs the redundant origin. It touches nothing else.
#
# Safe by construction: acts ONLY on the three-flag backgrounding signature (a normal
# startup lacks it -> no-op); resolves the origin pid pid-reuse-safely by sessionId; never
# self; SIGTERM only (transcript persists, resumable). Always exits 0 so it can never block
# a session from starting.
#
# Test seams (defaults are the real thing): REAP_CMDLINE_SOURCE, CLAUDE_SESSIONS_DIR,
# AGENT_VIEW_DIR, REAP_KILLCMD, REAP_LOG.
set -u

sessions_dir="${CLAUDE_SESSIONS_DIR:-$HOME/.claude/sessions}"
av_dir="${AGENT_VIEW_DIR:-$HOME/.claude/agent-view}"
killcmd="${REAP_KILLCMD:-kill}"
logfile="${REAP_LOG:-$HOME/.local/state/reap-origin.log}"

own_sid=""
if input=$(cat 2>/dev/null) && [ -n "$input" ]; then
  own_sid=$(printf '%s' "$input" | jq -r '.session_id // ""' 2>/dev/null)
fi

# --- find OUR OWN session-worker cmdline. Test seam short-circuits the /proc walk. ---
# The hook is a child of Claude's session-worker process (the one launched with
# --session-id <own_sid>). Walk up the ancestry and stop at the nearest process whose
# cmdline is that worker — identified by --session-id, and, when we know it, our OWN sid.
# Scoping to our own worker (not a blind union of all ancestors) keeps the signature match
# off shared daemon infrastructure, so an unrelated ancestor can never trigger a reap.
cmdline=""
if [ -n "${REAP_CMDLINE_SOURCE:-}" ]; then
  cmdline="$REAP_CMDLINE_SOURCE"
else
  pid=$PPID hops=0
  while [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$hops" -lt 8 ]; do
    if [ -r "/proc/$pid/cmdline" ]; then
      c=" $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) "
      if [[ "$c" == *" --session-id "* ]] && { [ -z "$own_sid" ] || [[ "$c" == *" $own_sid "* ]]; }; then
        cmdline="$c"; break
      fi
    fi
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)   # field 4 = ppid
    hops=$((hops + 1))
  done
fi

# --- signature gate: all three markers, else no-op ---
case " $cmdline " in *" --fork-session "*) ;; *) exit 0;; esac
case " $cmdline " in *" --reply-on-resume "*) ;; *) exit 0;; esac
case "$cmdline" in *"--resume "*) ;; *) exit 0;; esac

# origin sid = basename of the token after --resume, minus .jsonl
resume_path=""
# shellcheck disable=SC2086  # deliberate word-split: tokenize the space-joined cmdline
set -- $cmdline
while [ $# -gt 0 ]; do
  if [ "$1" = "--resume" ]; then resume_path="${2:-}"; break; fi
  shift
done
case "$resume_path" in *.jsonl) ;; *) exit 0;; esac
origin_sid="${resume_path##*/}"; origin_sid="${origin_sid%.jsonl}"

# guard: non-empty and never self
[ -n "$origin_sid" ] || exit 0
[ "$origin_sid" != "$own_sid" ] || exit 0

# resolve origin pid pid-reuse-safely: the sessions/<pid>.json whose sessionId matches
origin_pid=""
shopt -s nullglob
for pf in "$sessions_dir"/*.json; do
  if [ "$(jq -r '.sessionId // ""' "$pf" 2>/dev/null)" = "$origin_sid" ]; then
    origin_pid=$(jq -r '.pid // ""' "$pf" 2>/dev/null)
    break
  fi
done
shopt -u nullglob
[ -n "$origin_pid" ] || exit 0

# never signal ourselves / a non-numeric pid
case "$origin_pid" in ''|*[!0-9]*) exit 0;; esac
[ "$origin_pid" != "$$" ] && [ "$origin_pid" != "$PPID" ] || exit 0

# SIGTERM (graceful): transcript stays on disk, resumable
"$killcmd" "$origin_pid" 2>/dev/null

# drop the Agentview row so it vanishes now instead of on the next dead-pid prune
rm -f "$av_dir/$origin_sid.json" 2>/dev/null

# audit
mkdir -p "$(dirname "$logfile")" 2>/dev/null
printf '%s reaped origin %s pid=%s from fork %s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$origin_sid" "$origin_pid" "${own_sid:-?}" \
  >> "$logfile" 2>/dev/null

exit 0
