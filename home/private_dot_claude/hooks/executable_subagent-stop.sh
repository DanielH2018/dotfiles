#!/bin/bash
# gen-hooks: register
#   event: SubagentStop
#   timeout: 5
#   order: 10
#   async: true
# SubagentStop hook: log subagent spawns for observability.
# The SubagentStop payload identifies the subagent (agent_type, agent_id) but
# carries no status/duration/description fields, so only spawn identity is logged.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

SESSION_ID=$(hook_field '.session_id // "unknown"')
AGENT_TYPE=$(hook_field '.agent_type // "unknown"')
AGENT_ID=$(hook_field '.agent_id // "unknown"')

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=subagent_stop type=$AGENT_TYPE agent_id=$AGENT_ID" >> "$LOG_DIR/sessions.log"

exit 0
