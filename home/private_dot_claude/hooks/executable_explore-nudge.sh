#!/usr/bin/env bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Grep|Glob
#   timeout: 5
#   order: 80
# PreToolUse (Grep|Glob): when this search is the third exploratory call in a row,
# add a one-line nudge toward a subagent.
#
# CLAUDE.md "Delegating to subagents": an answer that takes 3+ exploratory calls,
# searching for something whose location you don't know, goes to a subagent. The
# counter is the run of consecutive Grep/Glob/Read tool calls since the operator's last
# prompt, read from the transcript tail. Any other tool call ends the run, and an Agent
# call is such a call. The hook keeps no state: the transcript is the counter.
#
# It fires only when THIS call is exactly the third in its run, so each run is nudged
# once. The fourth and later calls in the same run stay quiet. Parallel calls land in
# the transcript as one record per tool_use, so the position of this call's
# tool_use_id in the run is its place in line. When the id is not written yet, the
# call is taken to come after the run.
#
# Registered on Grep|Glob only, not Read. A Read on a known path is the exception the
# rule names ("the targeted read"), and Read is the hottest tool; leaving it off keeps
# this process off most calls. Reads still count toward the run when a search follows
# them. A subagent's calls (payload carries agent_id) are skipped: exploring is its job.
#
# A nudge, not a decision: additionalContext only. A missing jq is silent. Opt out
# with CLAUDE_EXPLORE_NUDGE=0.

set -u

[ "${CLAUDE_EXPLORE_NUDGE:-}" = "0" ] && exit 0

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

[ -n "$(hook_field '.agent_id // empty')" ] && exit 0
transcript=$(hook_field '.transcript_path // empty')
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0
id=$(hook_field '.tool_use_id // empty')
name=$(hook_field '.tool_name // empty')

# 512 KiB of tail holds any realistic run; records carry large tool results, so a
# line count would bound nothing. The first line is cut mid-record and is dropped.
position=$(tail -c 524288 "$transcript" | tail -n +2 | jq -n --arg id "$id" --arg name "$name" '
  def explorer: . == "Grep" or . == "Glob" or . == "Read";
  def prompt:
    (.content | type) as $t
    | if $t == "string" then (.content | startswith("Stop hook feedback") | not)
      elif $t == "array" then
        ((.content | length) > 0)
        and ([.content[] | select(type == "object" and .type == "tool_result")] | length) < (.content | length)
      else false end;
  [ inputs
    | select((.isSidechain // false) | not)
    | .message? | select(type == "object")
    | if .role == "assistant" then
        (.content // [] | if type == "array" then .[] else empty end
         | select(type == "object" and .type == "tool_use") | {n: .name, id: .id})
      elif .role == "user" and prompt then {p: true}
      else empty end ]
  | reduce .[] as $e ([]; if $e.p then [] else . + [$e] end)
  | (map(.id) | index($id)) as $i
  | (if $i == null then . + [{n: $name, id: $id}] else .[:($i + 1)] end)
  | map(.n | explorer) | reverse | (index([false]) // length)
' 2>/dev/null)

[ "$position" = "3" ] || exit 0

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: "[explore-nudge] This is the third search in a row. CLAUDE.md: if answering takes 3+ exploratory calls to find something whose location you do not know, dispatch a subagent (Explore) and keep only its findings. A targeted read of a known file and symbol is the exception; carry on if that is what this is."
  }
}'
exit 0
