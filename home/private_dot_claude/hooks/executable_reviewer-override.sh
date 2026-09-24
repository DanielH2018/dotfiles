#!/usr/bin/env bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Agent|Task
#   timeout: 5
#   order: 70
# PreToolUse (Agent|Task): deny a `feature-dev:code-reviewer` dispatch whose prompt does
# not override the agent's built-in reporting gate.
#
# The bundled agent reports only findings it scores at confidence >= 80. CLAUDE.md's
# "Code review" section asks for every finding, each with a score, and says to state
# that override in the dispatch prompt, because the agent follows its own gate
# literally and the findings under it are never seen. Whether the prompt states it is
# a substring question, so this hook asks it.
#
# The prompt passes when one sentence-sized window holds both "overrid..." and "80", in
# either order. The deny reason carries a sentence that passes, so the retry succeeds on
# the first attempt. Every other subagent type exits before the prompt is read.
#
# Registered on Agent|Task only, so it costs one bash process per subagent dispatch and
# nothing on any other tool. A missing jq is silent (hook_require_jq noop): this is a
# reminder, not a guard. Opt out with CLAUDE_REVIEWER_OVERRIDE_CHECK=0.

set -u

[ "${CLAUDE_REVIEWER_OVERRIDE_CHECK:-}" = "0" ] && exit 0

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

[ "$(hook_field '.tool_input.subagent_type // empty')" = "feature-dev:code-reviewer" ] || exit 0

prompt=$(hook_field '.tool_input.prompt // empty')
prompt=${prompt//$'\n'/ }
shopt -s nocasematch
if [[ $prompt =~ overrid.{0,160}80 || $prompt =~ 80.{0,160}overrid ]]; then
  exit 0
fi

SENTENCE='Report every finding you have, each with a confidence score and a severity; this overrides your built-in confidence >= 80 reporting gate, so do not filter.'
jq -n --arg s "$SENTENCE" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("feature-dev:code-reviewer reports only findings it scores at confidence >= 80, and CLAUDE.md asks for every finding. State the override in the prompt and dispatch again. This sentence passes:\n\n" + $s)
  }
}'
exit 0
