#!/bin/bash
# gen-hooks: register
#   event: SessionEnd
#   timeout: 5
#   order: 10
#   async: true
# SessionEnd hook: scan the finished transcript for leaked credentials.
# Fires when a session terminates. Output is informational only (not shown to Claude).

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# ── Scan the finished transcript for credentials that reached it ───────────
# The Bash guard denies a command before it runs; it cannot cover a `grep` that happens to
# print a line CARRYING a key, because that command names no secret path and no decrypt
# verb. Nothing can be scrubbed after the fact either — no hook rewrites a tool result — so
# the transcript is scanned instead and the answer is a rotation, not a redaction.
#
# Detached because this hook runs under a 5s
# timeout, and extracting then scanning a long transcript takes longer than that. The
# daily timer (claude-transcript-scan.timer) covers every session this never completed
# for — a kill -9, a crash, or a scan outliving its parent.
leak_scan() {
  SCANNER="$HOME/.local/bin/claude-transcript-scan"
  [ -x "$SCANNER" ] || return 0
  T=$(hook_field '.transcript_path // empty')
  [ -n "$T" ] && [ -f "$T" ] || return 0
  # Not /dev/null. Findings themselves now survive in the scanner's pending marker, which
  # session-context.sh reads back — but the could-not-evaluate path (exit 3: no gitleaks,
  # no jq) announces itself only on stderr, and discarding that makes a detector that never
  # ran indistinguishable from one that ran clean. Truncated, not appended: this is the last
  # run's diagnosis rather than a history, and an unattended append grows without bound.
  RUNLOG="$HOME/.claude/logs/transcript-scan-last.log"
  mkdir -p "${RUNLOG%/*}"
  nohup "$SCANNER" --session "$T" >"$RUNLOG" 2>&1 &
  disown 2>/dev/null || true
}

leak_scan

exit 0
