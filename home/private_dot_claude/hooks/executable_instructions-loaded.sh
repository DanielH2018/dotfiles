#!/bin/bash
# gen-hooks: register
#   event: InstructionsLoaded
#   timeout: 5
#   order: 10
#   async: true
# InstructionsLoaded hook: log which CLAUDE.md and rule files are active.
# Helps debug path-scoped rules and monorepo instruction loading.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# M12/A19-05: this event's log write (session=... instructions_loaded: <path> to
# sessions.log) was 48-49% of that file's volume with zero readers, so the write
# itself is removed here rather than given a retention-manifest rotation row — a
# log nobody reads needs deleting, not a cap. See M12-retention.md §5, §10 open
# question 3 (revisit if a real reader for this data shows up later).
FILE_PATH=$(hook_field '.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0

exit 0
