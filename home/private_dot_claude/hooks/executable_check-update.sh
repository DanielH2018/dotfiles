#!/bin/bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup
#   timeout: 5
#   order: 100
# SessionStart hook: notify when Claude Code has been updated since last session
set -u

VERSION_FILE="$HOME/.claude/logs/last_known_version"
CURRENT=$(claude --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

[ -z "$CURRENT" ] && exit 0

mkdir -p "$(dirname "$VERSION_FILE")"

if [ -f "$VERSION_FILE" ]; then
  LAST=$(cat "$VERSION_FILE")
  if [ "$CURRENT" != "$LAST" ]; then
    printf '%s' "$CURRENT" > "$VERSION_FILE"
    echo "Claude Code was updated from v$LAST to v$CURRENT. Mention this to the user and suggest checking the changelog."
  fi
else
  printf '%s' "$CURRENT" > "$VERSION_FILE"
fi

exit 0
