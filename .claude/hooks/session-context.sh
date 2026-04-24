#!/bin/bash
# SessionStart hook: inject useful context at the start of each session.
# Text printed to stdout is added as context Claude can see.
# Keep this FAST - it runs every time you open Claude Code.

set -u

# Only inject for new sessions, not resumes (which already have context).
SOURCE=$(jq -r '.source // "startup"')
[ "$SOURCE" != "startup" ] && exit 0

# Only bother if we're in a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

echo "=== Repo context ==="
echo "Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "Last commit: $(git log -1 --pretty=format:'%h %s (%cr)' 2>/dev/null)"

# Uncommitted changes, if any.
DIRTY=$(git status --porcelain 2>/dev/null | head -20)
if [ -n "$DIRTY" ]; then
  echo ""
  echo "Uncommitted changes:"
  echo "$DIRTY"
fi

# Recent commits for context on what the user has been working on.
echo ""
echo "Recent commits:"
git log -5 --pretty=format:'  %h %s' 2>/dev/null

exit 0
