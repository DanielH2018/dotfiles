# shellcheck shell=bash
# run_bounded: no child process that a hook invokes may run, buffer, or allocate
# without an explicit, enforced ceiling on wall-clock time and output bytes — and
# hitting a ceiling must report as could-not-evaluate, never as pass or as an
# ordinary fail. See ~/.claude/specs/env-modules/M10-bounded-execution.md §2/§9.
#
# Self-contained on purpose: this file sets RB_STATUS/RB_EXIT/RB_SIGNAL/RB_OUT and
# never calls exit and never sources outcome-lib.sh. Mapping RB_STATUS onto M06's
# could-not-evaluate bucket (oc_mark/oc_cannot) is the caller's decision — see
# lint-after-edit.sh for the reference wiring, and its comment on why it calls
# oc_mark rather than oc_cannot.
#
# RB_STATUS after a call:
#   ok        - ran to completion inside both bounds; RB_EXIT is the command's own
#               exit code (0 or non-zero — a non-zero here is a real verdict, not
#               could-not-evaluate)
#   timeout   - hit the wall-clock ceiling: SIGTERM, escalated to SIGKILL after a
#               2s grace period if the child ignores TERM (covers a child blocked
#               on a dead socket, which won't self-terminate on TERM alone)
#   truncated - hit the byte ceiling; RB_OUT holds exactly the first max_bytes
#   killed    - the child died from a signal unrelated to our own timeout/kill-after
#               (e.g. SIGSEGV) — distinct from "timeout" so a crash isn't misread
#               as a slow command
#   error     - run_bounded itself could not set up (e.g. mktemp failed); treat
#               like could-not-evaluate, not like the command ran and passed
#
# timeout/truncated/killed/error are ALL could-not-evaluate. None of them is ever
# a pass or a fail verdict about the command that was run.
#
# Usage: run_bounded <timeout_s> <max_bytes> [<mem_kb>] -- cmd args...
#   mem_kb bounds address space via `ulimit -v` in the child shell before exec.
#   Caveat: a JVM largely ignores a parent-set ulimit -v (mmap-based heap) — bound
#   JVM children via -Xmx/GRADLE_OPTS instead of mem_kb (open question in the spec).
#
# shellcheck disable=SC2034  # RB_OUT/RB_EXIT/RB_SIGNAL are the out-params callers read
run_bounded() {
  local t="$1" cap="$2" mem=""
  shift 2
  case "${1:-}" in
    --) shift ;;
    *) mem="$1"; shift; [ "${1:-}" = -- ] && shift ;;
  esac

  local tmp
  tmp=$(mktemp 2>/dev/null) || { RB_STATUS=error; RB_OUT=""; RB_EXIT=""; RB_SIGNAL=""; return 1; }

  # `head -c` enforces the byte cap by letting the OS pipe buffer fill, not by
  # buffering the whole output first — the cap holds even if the child never
  # stops writing.
  timeout --signal=TERM --kill-after=2s "$t" \
    bash -c "${mem:+ulimit -v $mem; }exec \"\$@\"" _ "$@" \
    2>&1 | head -c "$cap" >"$tmp"
  local rc=${PIPESTATUS[0]}

  local size
  size=$(wc -c <"$tmp" 2>/dev/null); size=${size:-0}
  RB_OUT=$(cat "$tmp" 2>/dev/null)
  rm -f "$tmp" 2>/dev/null

  RB_STATUS=ok
  RB_SIGNAL=""
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    RB_STATUS=timeout
  elif [ "$rc" -gt 128 ] 2>/dev/null; then
    RB_STATUS=killed
    RB_SIGNAL=$((rc - 128))
  fi
  if [ "$RB_STATUS" = ok ] && [ "$size" -ge "$cap" ] 2>/dev/null; then
    RB_STATUS=truncated
  fi
  RB_EXIT=$rc
  return 0
}
