#!/bin/bash
# gen-hooks: register
#   event: PostCompact
#   timeout: 5
#   order: 10
# PostCompact hook: remind Claude to verify critical context survived compaction.

set -u

# The jq-missing policy, expressed once (hook-input.sh, hook_require_jq). Without it
# this hook exited 127 and printed `jq: command not found` to the harness's hook-stderr
# channel on every compaction of a machine without jq. A reminder that cannot be built
# is a no-op, not an error worth reporting: noop, the same posture chezmoi-guard.sh
# takes. This hook reads no stdin, so it never calls hook_read_input.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_require_jq noop || exit 0

jq -n '{
  "continue": true,
  "systemMessage": "Post-compact: re-read CLAUDE.md if you are unsure about project conventions. Check git status to reorient on the current task."
}'
