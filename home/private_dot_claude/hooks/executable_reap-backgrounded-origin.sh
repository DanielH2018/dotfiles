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

# Shared detection + reap lives in the lib (single source of truth with the periodic sweep).
# REAP_LIB seam lets tests point at the in-repo copy.
# shellcheck source=/dev/null
. "${REAP_LIB:-$HOME/.claude/hooks/reap-origin-lib.sh}"
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

own_sid=$(hook_field '.session_id // ""')

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

# signature gate + origin resolution + graceful reap all live in the shared lib
reap_origin_from_cmdline "$cmdline" "$own_sid"
exit 0
