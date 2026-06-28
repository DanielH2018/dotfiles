#!/bin/bash
# PostToolUse hook for Bash: trim very long test/build output down to matched
# failures/errors + the tail (summary), to save context tokens.
#
# PostToolUse-only by design: it never rewrites the command or affects the exit
# status (unlike a PreToolUse rewrite, which would risk masking test failures).
#
# It DEFERS (does nothing) whenever the output could contain a PAN, so it never
# contends with redact-pan.sh over `updatedToolOutput`. PostToolUse hooks run in
# parallel and the composition of multiple updatedToolOutput emitters is undefined;
# redact-pan only emits when it finds a PAN, this only emits when there is none, so
# at most one of the two ever rewrites a given output.

set -u

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)
TOOL_OUTPUT=$(printf '%s' "$INPUT" | jq -r '.tool_output // empty' 2>/dev/null)

[ -z "$TOOL_OUTPUT" ] && exit 0

# Only act on known-noisy test/build runners.
printf '%s' "$COMMAND" | grep -qE '(\bpytest\b|\bgo test\b|\bcargo test\b|\bjest\b|\bvitest\b|npm (run )?test\b|yarn test\b|pnpm test\b|gradlew[^|]*test|mvn[^|]*test|\bmake test\b)' || exit 0

# Only when the output is genuinely long (small outputs aren't worth touching).
LINE_COUNT=$(printf '%s\n' "$TOOL_OUTPUT" | wc -l | tr -d ' ')
[ "$LINE_COUNT" -lt 60 ] && exit 0

# PCI: if a PAN-like digit run is present, defer to redact-pan.sh — never co-emit.
printf '%s' "$TOOL_OUTPUT" | grep -qE '[0-9]{13,19}' && exit 0

FAILS=$(printf '%s\n' "$TOOL_OUTPUT" | grep -niE -A2 -B1 '(fail|error|✗|✘|panic|traceback|assert|exception|timeout|refused)' | head -150)
TAIL=$(printf '%s\n' "$TOOL_OUTPUT" | tail -15)
FILTERED=$(printf '[test-output-filter: original %s lines; showing matched failures/errors (if any) + last 15 lines. Exit status is unaffected.]\n\n%s\n\n--- last 15 lines ---\n%s\n' "$LINE_COUNT" "$FAILS" "$TAIL")

# Only replace if we actually shortened it.
FILTERED_LINES=$(printf '%s\n' "$FILTERED" | wc -l | tr -d ' ')
[ "$FILTERED_LINES" -ge "$LINE_COUNT" ] && exit 0

jq -n --arg out "$FILTERED" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    updatedToolOutput: $out,
    additionalContext: "Long test/build output was trimmed to failures + tail to save context; exit status is unchanged."
  }
}'
exit 0
