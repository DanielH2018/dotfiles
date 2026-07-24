#!/bin/bash
# SessionStart hook: register external paths for FileChanged notifications.
# When files change at these paths, Claude gets a FileChanged event.

set -u

# shellcheck disable=SC1091  # optional per-host env, not present in the chezmoi tree
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
[ "$SOURCE" != "startup" ] && exit 0

PATHS='[]'

# Watch the vault raw/ directory for new ingest material (only when a vault is configured)
if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
  RAW_DIR="$CLAUDE_VAULT_DIR/raw"
  [ -d "$RAW_DIR" ] && PATHS=$(jq -n --arg p "$RAW_DIR" '[$p]')
fi

# Watch the global rules directory for rule changes
RULES_DIR="$HOME/.claude/rules"
[ -d "$RULES_DIR" ] && PATHS=$(echo "$PATHS" | jq --arg p "$RULES_DIR" '. + [$p]')

jq -n --argjson paths "$PATHS" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    watchPaths: $paths
  }
}'
