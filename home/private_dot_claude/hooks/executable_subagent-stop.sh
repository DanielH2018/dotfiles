#!/bin/bash
# SubagentStop hook: log subagent spawns for observability.
# The SubagentStop payload identifies the subagent (agent_type, agent_id) but
# carries no status/duration/description fields, so only spawn identity is logged.

set -u

INPUT=$(cat)
LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // "unknown"' 2>/dev/null)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // "unknown"' 2>/dev/null)

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) session=$SESSION_ID event=subagent_stop type=$AGENT_TYPE agent_id=$AGENT_ID" >> "$LOG_DIR/sessions.log"

exit 0
