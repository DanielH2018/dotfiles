#!/bin/bash
# PreCompact hook: fires on auto-compact only (not manual /compact).
# Allows compaction but injects a reminder to capture session insights.

jq -n '{
  "continue": true,
  "systemMessage": "Auto-compact proceeding. If this session contains important decisions, patterns, or feedback, run /capture-session after compaction to preserve them in memory."
}'
