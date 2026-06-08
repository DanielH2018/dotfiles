#!/bin/bash
# PreToolUse hook for Read/Edit/Write: deny access to sensitive files.
# The deny permission rules in settings already cover this, but a hook
# gives a clearer reason and handles patterns that permission globs miss.

set -u

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
  */.env|*/.env.*|*/.env.local|*/.env.production)
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
