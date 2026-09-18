#!/usr/bin/env bash
# gen-hooks: library
#   reason: top of the agent-view chain and nothing in this tree invokes it since agentview was deleted (0e6bded); kept pending the deletion question filed from #528
# Track the subagents a session still has outstanding, so the Agent View picker doesn't
# call a session "completed" while it is really waiting on one.
# Usage: agent-view-subagents.sh <start|stop>
#
# An async subagent outlives the turn that launched it: the parent's turn ends, Stop fires,
# and the row reads completed/review while four agents are still running. SubagentStart and
# SubagentStop both carry the PARENT session_id, so the outstanding set can be keyed by the
# same id the registry row uses. agent-view-state.sh reads that set before writing completed;
# this script stamps the row back to completed once the last one lands.
# Emits NOTHING on stdout.
set -u

action="${1:-}"
# shellcheck disable=SC1091  # deployed sibling; source name differs in the chezmoi tree
source "$HOME/.claude/hooks/agent-view-register.sh"
# shellcheck source=/dev/null
source "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

sid=$(hook_field '.session_id // empty')
[ -z "$sid" ] && exit 0
agent_id=$(hook_field '.agent_id // empty')
[ -z "$agent_id" ] && exit 0

dir="$(av_dir)-subagents"
file="$dir/$sid"
now=$(date +%s 2>/dev/null || echo 0)

# A start whose matching stop never arrives (crash, kill -9) would pin the row to "working"
# forever, so entries expire. Six hours is far longer than any real subagent and far shorter
# than "until the next reboot".
MAX_AGE=21600

# av_subagents_live -> print the non-expired entries of $file, one "<ts> <agent_id>" per line.
av_subagents_live() {
  [ -f "$file" ] || return 0
  while read -r ets eid; do
    case "$ets" in ''|*[!0-9]*) continue;; esac
    [ -z "$eid" ] && continue
    [ $((now - ets)) -gt "$MAX_AGE" ] && continue
    printf '%s %s\n' "$ets" "$eid"
  done < "$file"
}

case "$action" in
  start)
    mkdir -p "$dir" 2>/dev/null
    { av_subagents_live | grep -vF " $agent_id" ; printf '%s %s\n' "$now" "$agent_id"; } > "$file.tmp.$$" 2>/dev/null
    mv -f "$file.tmp.$$" "$file" 2>/dev/null || rm -f "$file.tmp.$$" 2>/dev/null
    ;;
  stop)
    [ -f "$file" ] || exit 0
    remaining=$(av_subagents_live | grep -vF " $agent_id")
    if [ -n "$remaining" ]; then
      printf '%s\n' "$remaining" > "$file.tmp.$$" 2>/dev/null
      mv -f "$file.tmp.$$" "$file" 2>/dev/null || rm -f "$file.tmp.$$" 2>/dev/null
      exit 0
    fi
    rm -f "$file" 2>/dev/null
    # Last one landed. The Stop that fired while they were running was downgraded to
    # "working", and nothing else corrects it if the parent is never re-invoked — so stamp
    # it here, by re-running the state hook rather than writing the row directly. That
    # matters for the dirty-tree case: git_review_marker only runs on the completed path in
    # that hook, so a direct state-only write would leave the row COMPLETED when it should
    # be REVIEW. The set file is already gone, so the gate there falls through.
    #
    # A parent that has since started a new turn also reads "working", and gets stamped
    # completed for the moment it takes its own next Stop to overwrite. Distinguishing the
    # two needs a turn counter the hook payload doesn't carry; the row self-heals, so the
    # brief flicker is the accepted cost of not stranding a row that won't.
    row="$(av_dir)/$sid.json"
    [ -f "$row" ] || exit 0
    [ "$(jq -r '.state // ""' < "$row" 2>/dev/null)" = "working" ] || exit 0
    jq -nc --arg sid "$sid" --arg cwd "$(jq -r '.cwd // ""' < "$row" 2>/dev/null)" \
      '{session_id:$sid, cwd:$cwd}' 2>/dev/null \
      | "$HOME/.claude/hooks/agent-view-state.sh" completed >/dev/null 2>&1
    ;;
  *) exit 0;;
esac
exit 0
