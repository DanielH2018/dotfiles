#!/usr/bin/env bash
# In-container Agent View state hook (Phase 2). Wired to Claude's UserPromptSubmit /
# Notification / Stop events INSIDE the claude-sandbox container. Flips ONLY the `state`
# of the row the HOST launcher already registered for this session, joined by
# AGENT_VIEW_KEY (= the launcher's INSTANCE_ID). It never creates or deletes the row —
# the launcher owns identity + lifecycle (resurrection guard, spec §3). No `set -e`: it
# sources the shared helper, which must not fail-on-error a hook. Emits NOTHING on stdout.
# Usage: agent-view-state-hook.sh <working|needs-input|completed>
# Drain the event JSON before anything else. The state comes from $1, so the payload is
# unused -- but Claude writes it to our stdin regardless, and exiting without reading it
# leaves that write racing a pipe we already closed (EPIPE for the caller). The no-key
# no-op below is the fastest exit and so the most likely to lose that race. Every sibling
# hook consumes stdin the same way.
cat >/dev/null 2>&1
key="${AGENT_VIEW_KEY:-}"
[ -n "$key" ] || exit 0                       # exec/shell containers never set it -> no-op
helper="$HOME/.claude/hooks/agent-view-register.sh"
[ -f "$helper" ] || exit 0
# shellcheck source=/dev/null
source "$helper"
declare -f av_update_state >/dev/null 2>&1 && av_update_state "$key" "${1:-working}"
exit 0
