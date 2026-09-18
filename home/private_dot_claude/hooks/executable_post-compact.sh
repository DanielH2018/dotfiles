#!/bin/bash
# gen-hooks: register
#   event: PostCompact
#   timeout: 5
#   order: 10
# PostCompact hook: remind Claude to verify critical context survived compaction.

set -u

jq -n '{
  "continue": true,
  "systemMessage": "Post-compact: re-read CLAUDE.md if you are unsure about project conventions. Check git status to reorient on the current task."
}'
