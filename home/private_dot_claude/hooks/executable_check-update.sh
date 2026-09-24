#!/bin/bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup
#   timeout: 5
#   order: 100
# SessionStart hook: notify when Claude Code has been updated since last session
#
# `claude --version` runs through run_bounded, like every other hook child (#581, #657).
# It used to run bare, so a hung one held session start until the harness killed the hook
# at 5s. A version that did not finish is said on stderr and nothing is recorded. A missing
# run-bounded.sh is a broken install: say so and exit 1, which the harness reports as a
# non-blocking hook error, as auto-format.sh does.
set -u

RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  printf 'check-update: cannot load %s; the Claude Code version was not checked\n' "$RUN_BOUNDED_PATH" >&2
  exit 1
fi
T_VERSION=${CHECK_UPDATE_TIMEOUT_S:-3}

VERSION_FILE="$HOME/.claude/logs/last_known_version"
run_bounded "$T_VERSION" 4096 -- bash -c 'exec claude --version 2>/dev/null' </dev/null
if [ "$RB_STATUS" != ok ]; then
  printf 'check-update: claude --version did not finish within %ss (%s); the version was not checked\n' \
    "$T_VERSION" "$RB_STATUS" >&2
  exit 0
fi
CURRENT=$(printf '%s\n' "$RB_OUT" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

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
