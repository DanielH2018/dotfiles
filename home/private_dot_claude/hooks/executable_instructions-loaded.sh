#!/bin/bash
# InstructionsLoaded hook: log which CLAUDE.md and rule files are active.
# Helps debug path-scoped rules and monorepo instruction loading.

set -u

INPUT=$(cat)

# M12/A19-05: this event's log write (session=... instructions_loaded: <path> to
# sessions.log) was 48-49% of that file's volume with zero readers, so the write
# itself is removed here rather than given a retention-manifest rotation row — a
# log nobody reads needs deleting, not a cap. See M12-retention.md §5, §10 open
# question 3 (revisit if a real reader for this data shows up later).
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

exit 0
