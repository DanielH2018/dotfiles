#!/bin/bash
# PreCompact hook: fires on auto-compact only (not manual /compact).
# Blocks auto-compaction with a reminder to run /capture-session first.
# Override: just run /compact manually.

jq -n '{
  "continue": false,
  "systemMessage": "Auto-compact blocked — run /capture-session first, then /compact to proceed manually."
}'
