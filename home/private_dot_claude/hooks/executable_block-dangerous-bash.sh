#!/bin/bash
# PreToolUse hook for Bash: deny patterns that are usually mistakes.
# Returns a structured PreToolUse decision via JSON on stdout.

set -u

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# rm -rf targeting home or root (handles separated flags: rm -r -f /, rm --recursive --force /)
if echo "$COMMAND" | grep -qiE '\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b.*(\s/[[:space:]]|\s/$|\s~|\s\$HOME)'; then
  deny "Blocked: rm -rf targeting home or root directory. Use a specific path instead."
fi
if echo "$COMMAND" | grep -qiE '\brm\s' && echo "$COMMAND" | grep -qiE '(\s-[a-zA-Z]*r|\s--recursive)' && echo "$COMMAND" | grep -qiE '(\s-[a-zA-Z]*f|\s--force)' && echo "$COMMAND" | grep -qE '(\s/[[:space:]]|\s/$|\s~|\s\$HOME)'; then
  deny "Blocked: rm -rf targeting home or root directory. Use a specific path instead."
fi

# Force-push to main / master (flag syntax and +refspec syntax) — always blocked
# Exclude --force-with-lease which is the safe variant
if echo "$COMMAND" | grep -qE 'git\s+push.*(--force([ ]|$)|[ ]-f([ ]|$))' && ! echo "$COMMAND" | grep -q '\-\-force-with-lease'; then
  if echo "$COMMAND" | grep -qE '\b(main|master)\b'; then
    deny "Blocked: force-push to main/master. Use a feature branch."
  fi
fi
if echo "$COMMAND" | grep -qE 'git\s+push.*\+\s*(main|master|refs/heads/(main|master))\b'; then
  deny "Blocked: force-push via +refspec to main/master. Use a feature branch."
fi

# Force-push to other branches — upgrade to --force-with-lease and surface a message
# BSD sed (macOS) doesn't support \b, so use space/EOL anchoring instead
if echo "$COMMAND" | grep -qE 'git\s+push.*(--force([ ]|$)|[ ]-f([ ]|$))' && ! echo "$COMMAND" | grep -q '\-\-force-with-lease'; then
  UPGRADED=$(echo "$COMMAND" | sed -E 's/--force([ ]|$)/--force-with-lease\1/g; s/([ ])-f([ ]|$)/\1--force-with-lease\2/g')
  jq -n --arg cmd "$UPGRADED" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: $cmd },
      additionalContext: "NOTE: --force was upgraded to --force-with-lease for safety. This prevents overwriting commits pushed by others. The push will still succeed if no one else has pushed to this branch."
    }
  }'
  exit 0
fi

# Curl-pipe-to-shell
if echo "$COMMAND" | grep -qE '(curl|wget)[^|]*\|\s*(sh|bash|zsh)'; then
  deny "Blocked: piping remote content to a shell. Download, inspect, then run."
fi

# Writing to protected files
if echo "$COMMAND" | grep -qE '>\s*(\.env|~?/\.ssh/|~?/\.aws/credentials)'; then
  deny "Blocked: writing to a secrets file. Ask the user to do this manually."
fi

# Fork bomb
if echo "$COMMAND" | grep -qE ':\(\)\{.*\};:'; then
  deny "Blocked: fork bomb detected."
fi

# Generic pipe-to-shell (belt-and-suspenders with permissions.deny)
if echo "$COMMAND" | grep -qE '\|\s*(sh|bash|zsh|dash|fish)\b'; then
  deny "Blocked: piping output to a shell interpreter. Download, inspect, then run."
fi

# Disk-wipe commands
if echo "$COMMAND" | grep -qE '\b(mkfs|dd\s+if=.*of=/dev/|fdisk|parted)\b'; then
  deny "Blocked: low-level disk operation."
fi

# Reading secret files via bash commands (bypasses Read deny rules)
# Only check arguments before the first pipe — jq expressions like '.key' are not file paths.
SECRET_PATHS='(\.env|\.ssh/|id_rsa|id_ed25519|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.pem|\.key|\.p12|\.pfx)'
CMD_ARGS="${COMMAND%%|*}"
if echo "$CMD_ARGS" | grep -qE "\b(cat|head|tail|less|more|bat|strings|xxd|hexdump)\b.*$SECRET_PATHS"; then
  deny "Blocked: reading a secrets file via bash. Use a non-sensitive path or ask the user to share the specific value needed."
fi

# Writing to secret paths via pipe (tee) or redirection — check the full command
if echo "$COMMAND" | grep -qE "(>|tee\s+)\s*~?/?$SECRET_PATHS"; then
  deny "Blocked: writing to a secrets file via pipe/redirect. Ask the user to do this manually."
fi

exit 0
