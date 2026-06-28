#!/bin/bash
# SessionStart hook: register external paths for FileChanged notifications.
# When files change at these paths, Claude gets a FileChanged event.

set -u

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
[ "$SOURCE" != "startup" ] && exit 0

PATHS='[]'

# Watch the vault raw/ directory for new ingest material
RAW_DIR="$HOME/Documents/My_Vault/raw"
[ -d "$RAW_DIR" ] && PATHS=$(jq -n --arg p "$RAW_DIR" '[$p]')

# Watch the global rules directory for rule changes
RULES_DIR="$HOME/.claude/rules"
[ -d "$RULES_DIR" ] && PATHS=$(echo "$PATHS" | jq --arg p "$RULES_DIR" '. + [$p]')

jq -n --argjson paths "$PATHS" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    watchPaths: $paths
  }
}'
