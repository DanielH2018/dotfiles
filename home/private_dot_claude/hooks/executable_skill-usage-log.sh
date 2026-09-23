#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: Skill|Agent|Task
#   timeout: 10
#   order: 100
# Fire-count logging: nothing recorded which of the 23 skills / 5 agents under
# private_dot_claude/{skills,agents} ever actually fire, so a scaffolding-
# delete-pass had no evidence to weigh a removal against. Both "Agent" and
# "Task" are named in the matcher for the same reason the hook itself checks
# both tool_name spellings -- the harness has used either name for the
# subagent-dispatch tool across versions, and matching only one silently
# stops logging agent dispatches the next time it changes back.
# PostToolUse hook (matcher: Skill|Agent): append one JSONL record per skill invocation
# and per agent dispatch to ~/.claude/logs/skill-usage.jsonl.
#
# Nothing recorded which of the 23 skills and 5 agents under
# home/private_dot_claude/{skills,agents} ever actually fire, so a scaffolding-delete-
# pass had no fire count to weigh a removal against. This is the write side; bin/skill-
# usage (repo root) reads the file back into a table.
#
# tool_name is handled as both "Agent" and "Task" because the harness has used both
# spellings for the subagent-dispatch tool across versions (see log-permission.js in
# vault-tooling/claude-audit-portable, which carries the same fallback for the same
# reason) -- matching only one would silently stop logging agent dispatches the next
# time the harness's own name for the tool changes back.
#
# Never fails the tool call: every failure path below falls through to a silent
# `exit 0` with nothing written, same convention as subagent-stop.sh -- except a
# missing run-bounded.sh, a broken install rather than a bad payload, which exits 1.
# This hook has no verdict to give, so it does not use outcome-lib.sh -- there is
# nothing here that is ever could-not-evaluate as opposed to just not written.
#
# No separate OTEL emission here. CLAUDE_CODE_ENABLE_TELEMETRY and
# OTEL_LOG_TOOL_DETAILS are both already on in settings.base.json, so every Skill/Agent
# tool call already lands in Loki as an event log carrying tool_name and its full
# tool_input (skill name / subagent_type) on any host running the claude-otel stack --
# see home/claude-otel/README.md. That is a genuinely cheap existing path, not a reason
# to skip this file: Loki's retention is 31 days against this file's unbounded history,
# daniel-pi carries no exporter at all, and daniel-server/daniel-box route through
# their own collector, which is not guaranteed to forward Claude Code's signals
# anywhere. skill-usage.jsonl (this file) is the one source bin/skill-usage can rely
# on existing on every host; Loki is a bonus query surface on the hosts where it runs.
set -u

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
# run-bounded.sh is required. This file used to define its own unbounded run_bounded() when
# the library did not source, a second copy of the primitive that bounded nothing (#581). The
# fire-count record does not depend on it, so a missing library still writes the row -- with
# cwd_repo falling back to the directory name, as it does for any failed lookup -- and then
# exits 1 naming the library, so the broken install is reported rather than absorbed.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-$LIB_DIR/run-bounded.sh}"
RB_MISSING=0
# shellcheck disable=SC1090,SC1091
{ . "$RUN_BOUNDED_PATH" 2>/dev/null && command -v run_bounded >/dev/null 2>&1; } || RB_MISSING=1
# shellcheck disable=SC1090,SC1091
. "${HOOK_INPUT_LIB:-$LIB_DIR/hook-input.sh}" 2>/dev/null || true

command -v hook_field >/dev/null 2>&1 || hook_field() { jq -r "$1" 2>/dev/null; }

command -v jq >/dev/null 2>&1 || exit 0
hook_read_input 2>/dev/null || true

TOOL=$(hook_field '.tool_name // empty')
case "$TOOL" in
  Skill) KIND=skill; NAME=$(hook_field '.tool_input.skill // .tool_input.command // empty') ;;
  Agent | Task) KIND=agent; NAME=$(hook_field '.tool_input.subagent_type // empty') ;;
  *) exit 0 ;;
esac
[ -z "$NAME" ] && exit 0

SESSION_ID=$(hook_field '.session_id // "unknown"')
CWD=$(hook_field '.cwd // empty')
# Best-effort: no PostToolUse payload sampled while writing this carried
# tool_response.is_error (the field is documented for the SDK's own query result and
# for a Skill/Agent's own success check, not confirmed on the hook payload). If the
# harness never sets it here, `ok` is just `true` forever -- decoration, not a signal
# -- rather than wrong, so it is left in rather than guessed at further.
OK=true
[ "$(hook_field '.tool_response.is_error // false')" = "true" ] && OK=false

# cwd_repo: the repo a worktree belongs to, not its own per-worktree path, so fire
# counts for the same repo accumulate across every worktree/session working it. Same
# --git-common-dir normalization worktree-context.sh uses, generalized to the two
# shapes `rev-parse --git-common-dir` can return (absolute, or relative to cwd).
CWD_REPO=""
if [ -n "$CWD" ]; then
  [ "$RB_MISSING" -eq 0 ] && run_bounded 3 4096 -- git -C "$CWD" rev-parse --git-common-dir
  if [ "$RB_MISSING" -eq 0 ] && [ "${RB_STATUS:-error}" = ok ] && [ "${RB_EXIT:-1}" -eq 0 ] && [ -n "${RB_OUT:-}" ]; then
    COMMON_RAW=$(printf '%s' "$RB_OUT" | tr -d '\n')
    case "$COMMON_RAW" in
      /*) COMMON_ABS=$(cd "$COMMON_RAW" 2>/dev/null && pwd -P) ;;
      *) COMMON_ABS=$(cd "$CWD/$COMMON_RAW" 2>/dev/null && pwd -P) ;;
    esac
    [ -n "$COMMON_ABS" ] && CWD_REPO=$(basename "$(dirname "$COMMON_ABS")")
  fi
  [ -z "$CWD_REPO" ] && CWD_REPO=$(basename "$CWD")
fi

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR" 2>/dev/null
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')

jq -nc --arg ts "$TS" --arg kind "$KIND" --arg name "$NAME" --arg sid "$SESSION_ID" \
  --arg repo "$CWD_REPO" --argjson ok "$OK" \
  '{ts: $ts, kind: $kind, name: $name, session_id: $sid, cwd_repo: $repo, ok: $ok}' \
  >>"$LOG_DIR/skill-usage.jsonl" 2>/dev/null

if [ "$RB_MISSING" -eq 1 ]; then
  printf 'skill-usage-log: cannot load %s; cwd_repo fell back to the directory name\n' \
    "$RUN_BOUNDED_PATH" >&2
  exit 1
fi
exit 0
