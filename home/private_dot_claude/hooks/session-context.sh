#!/bin/bash
# SessionStart hook: inject useful context at the start of each session.
# Text printed to stdout is added as context Claude can see.
# Keep this FAST - it runs every time you open Claude Code.

set -u

# Only inject for new sessions, not resumes (which already have context).
INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"')
[ "$SOURCE" != "startup" ] && exit 0

# Only bother if we're in a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

echo "=== Repo context ==="
echo "Branch: $BRANCH"
echo "Last commit: $(git log -1 --pretty=format:'%h %s (%cr)' 2>/dev/null)"

# Ahead/behind upstream, if tracking branch exists.
UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)
if [ -n "$UPSTREAM" ]; then
  AHEAD=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null)
  BEHIND=$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null)
  if [ "$AHEAD" -gt 0 ] || [ "$BEHIND" -gt 0 ]; then
    echo "Upstream: $UPSTREAM (ahead $AHEAD, behind $BEHIND)"
  fi
fi

# Uncommitted changes, if any.
DIRTY=$(git status --porcelain 2>/dev/null | head -20)
if [ -n "$DIRTY" ]; then
  echo ""
  echo "Uncommitted changes:"
  echo "$DIRTY"
fi

# In-progress rebase or merge — surface prominently.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  echo ""
  echo "WARNING: Rebase in progress — complete or abort before other work."
fi
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | head -5)
  echo ""
  if [ -n "$CONFLICTS" ]; then
    echo "WARNING: Merge in progress with unresolved conflicts:"
    echo "$CONFLICTS"
  else
    echo "WARNING: Merge in progress — commit or abort."
  fi
fi

# Stash count, if any.
STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -gt 0 ]; then
  echo ""
  echo "Stashes: $STASH_COUNT"
fi

# Recent commits for context on what the user has been working on.
echo ""
echo "Recent commits:"
git log -5 --pretty=format:'  %h %s' 2>/dev/null

exit 0
