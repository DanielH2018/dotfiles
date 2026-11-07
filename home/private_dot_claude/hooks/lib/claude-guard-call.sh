# shellcheck shell=bash
# claude_guard_call <subcommand> <timeout-s> <output-cap-bytes>
#   Run `python -m claude_guard.cli <subcommand>` on the cached hook payload, bounded by
#   run_bounded. The four hooks that launch claude_guard share this; each keeps its own
#   policy for a call that does not run, because those policies differ on purpose (an ask,
#   silence, a skip line, a regex fallback).
#
#   Returns 0 when the judge ran to completion and exited 0, with its output in RB_OUT.
#   Otherwise returns 1 and sets CG_FAIL to the reason. CG_FAIL=absent means the package
#   is not installed, which most callers treat as "nothing to do" rather than a fault.
#
#   Needs no jq: guard-pre-tool-use.sh's fail path runs where jq may be missing. The caller
#   reads the payload first (hook_read_input), since this feeds _HOOK_INPUT_RAW byte-for-byte.
#   CLAUDE_GUARD_TIMEOUT_S bounds the interpreter lookup (default 2s); callers pass it as
#   the judge bound too, for the tests. RUN_BOUNDED_LIB overrides the run-bounded.sh path.
# shellcheck disable=SC2034  # CG_FAIL is read by the sourcing hook
claude_guard_call() {
  CG_FAIL=''
  local lib_dir=${BASH_SOURCE[0]%/*}
  local share="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"
  local run_bounded_path="${RUN_BOUNDED_LIB:-$lib_dir/run-bounded.sh}"
  if [ ! -f "$share/claude_guard/cli.py" ]; then
    CG_FAIL=absent
    return 1
  fi
  # shellcheck source=/dev/null
  if ! . "$run_bounded_path" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
    CG_FAIL="cannot load $run_bounded_path"
    return 1
  fi
  # shellcheck source=/dev/null
  if ! . "$lib_dir/guard-python.sh" 2>/dev/null; then
    CG_FAIL="cannot load $lib_dir/guard-python.sh"
    return 1
  fi
  local find_s=${CLAUDE_GUARD_TIMEOUT_S:-2}
  if ! guard_python "$find_s"; then
    CG_FAIL="no interpreter from uv python find within ${find_s}s (${GUARD_PY_STATUS:-unknown})"
    return 1
  fi
  # Process substitution, not a pipe: a pipe would run run_bounded in a subshell and lose
  # RB_*, and a here-string appends a newline the payload never had. stderr is dropped in
  # the child because run_bounded merges it into RB_OUT, and a traceback can quote the command.
  # shellcheck disable=SC2016  # $1-$3 belong to the inner bash
  run_bounded "$2" "$3" -- \
    bash -c 'PYTHONPATH="$1" exec "$2" -S -P -m claude_guard.cli "$3" 2>/dev/null' \
    _ "$share" "$GUARD_PY" "$1" < <(printf '%s' "${_HOOK_INPUT_RAW:-}")
  if [ "$RB_STATUS" != ok ]; then
    CG_FAIL="claude_guard did not finish within ${2}s ($RB_STATUS)"
    return 1
  fi
  if [ "$RB_EXIT" -ne 0 ]; then
    CG_FAIL="claude_guard failed (exit $RB_EXIT)"
    return 1
  fi
}
