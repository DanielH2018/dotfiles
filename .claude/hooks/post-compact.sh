#!/bin/bash
# PostCompact hook: remind Claude to verify critical context survived compaction.

set -u

jq -n '{
  "continue": true,
  "systemMessage": "Post-compact: re-read CLAUDE.md if you are unsure about project conventions. Check git status to reorient on the current task."
}'
