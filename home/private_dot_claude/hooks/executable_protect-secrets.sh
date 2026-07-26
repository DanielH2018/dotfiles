#!/bin/bash
# PreToolUse hook for Read/Edit/Write: deny access to sensitive files.
# The deny permission rules in settings already cover this, but a hook
# gives a clearer reason and handles patterns that permission globs miss.

set -u

# Same fail-open as block-dangerous-bash had: no jq meant no file_path, so the hook
# exited 0 and the secret-file deny layer disappeared, leaving only the settings.json
# globs. Verified: a Read of ~/.ssh/id_rsa through a jq-free PATH returned rc=0 and no
# decision. Literal JSON so the fallback needs nothing but printf, and `ask` rather than
# `deny` because an unparsed input tells us nothing about which file is being touched —
# denying would block every Read/Edit/Write in the session, not just the guarded ones.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"protect-secrets: jq is unavailable, so the secret-file rules could not be evaluated. Check the path yourself before allowing."}}'
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

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

case "$FILE_PATH" in
  .env|*/.env|.env.*|*/.env.*)
    deny "Blocked: .env files may contain secrets. Ask the user to share the specific value needed."
    ;;
  */.ssh/*|*/id_rsa*|*/id_ed25519*|*/id_ecdsa*)
    deny "Blocked: SSH keys are never safe to read or modify automatically."
    ;;
  */.aws/credentials|*/.aws/config)
    deny "Blocked: AWS credentials file."
    ;;
  */.netrc|*/.pypirc|*/.npmrc)
    deny "Blocked: this file commonly contains auth tokens."
    ;;
  */.gnupg/*)
    deny "Blocked: GPG keyring."
    ;;
  *.pem|*.key|*.p12|*.pfx)
    deny "Blocked: looks like a private key or certificate."
    ;;
  */secrets/*)
    deny "Blocked: files under a secrets/ directory."
    ;;
esac

exit 0
