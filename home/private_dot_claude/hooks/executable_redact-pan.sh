#!/bin/bash
# PostToolUse hook for Bash: redact payment card numbers (PANs) from command output
# before they enter Claude's context. Defense-in-depth for PCI compliance —
# even if a query accidentally returns card data, Claude never sees the full PAN.
#
# Matches 13-19 digit sequences that pass a Luhn check, replacing all but the
# last four digits with [REDACTED-PAN]. Avoids false positives on timestamps,
# UUIDs, and other numeric strings by requiring Luhn validity.

set -u

INPUT=$(cat)
TOOL_OUTPUT=$(printf '%s' "$INPUT" | jq -r '.tool_output // empty')

# Skip if no output or output is short (no PAN could fit)
[ -z "$TOOL_OUTPUT" ] && exit 0
[ ${#TOOL_OUTPUT} -lt 13 ] && exit 0

# Quick check: does the output even contain a long digit sequence?
if ! printf '%s' "$TOOL_OUTPUT" | grep -qE '\b[0-9]{13,19}\b'; then
  exit 0
fi

# Use awk to find and validate PANs via Luhn algorithm, then redact.
# Builds output left-to-right so non-PAN digit sequences are skipped cleanly.
REDACTED=$(printf '%s' "$TOOL_OUTPUT" | awk '{
  line = $0
  out = ""
  while (match(line, /[0-9]{13,19}/)) {
    candidate = substr(line, RSTART, RLENGTH)
    # Luhn check
    n = length(candidate)
    sum = 0
    alt = 0
    for (i = n; i >= 1; i--) {
      d = substr(candidate, i, 1) + 0
      if (alt) {
        d *= 2
        if (d > 9) d -= 9
      }
      sum += d
      alt = !alt
    }
    if (sum % 10 == 0) {
      last4 = substr(candidate, n - 3, 4)
      out = out substr(line, 1, RSTART - 1) "[REDACTED-PAN-" last4 "]"
    } else {
      # Not a valid PAN — keep it verbatim and move past
      out = out substr(line, 1, RSTART + RLENGTH - 1)
    }
    line = substr(line, RSTART + RLENGTH)
  }
  print out line
}')

# Only emit updated output if something was actually redacted
if [ "$REDACTED" != "$TOOL_OUTPUT" ]; then
  jq -n --arg output "$REDACTED" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: $output,
      additionalContext: "WARNING: PAN(s) detected and redacted from command output. Review the command to ensure it is not querying cardholder data unnecessarily."
    }
  }'
fi

exit 0
