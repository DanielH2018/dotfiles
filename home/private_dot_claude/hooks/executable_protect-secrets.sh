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
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq ask "protect-secrets: jq is unavailable, so the secret-file rules could not be evaluated. Check the path yourself before allowing." || exit 0

FILE_PATH=$(hook_field '.tool_input.file_path // empty')
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
  # Each arm carries the bare form as well as the */-prefixed one. A relative path has no
  # separator to match — `.aws/credentials` from a cwd of $HOME is the same file as
  # /home/u/.aws/credentials, and only the .env arm handled that shape.
  # The OAuth token store on Linux and WSL. A different file from ~/.claude.json below,
  # which is where the deny list stopped — see .chezmoidata/secrets.toml.
  .credentials.json|*/.claude/.credentials.json)
    deny "Blocked: this is the Claude Code OAuth token store."
    ;;
  .aws/credentials|.aws/config|*/.aws/credentials|*/.aws/config)
    deny "Blocked: AWS credentials file."
    ;;
  .netrc|.pypirc|.npmrc|*/.netrc|*/.pypirc|*/.npmrc)
    deny "Blocked: this file commonly contains auth tokens."
    ;;
  .gnupg/*|*/.gnupg/*)
    deny "Blocked: GPG keyring."
    ;;
  *.pem|*.key|*.p12|*.pfx)
    deny "Blocked: looks like a private key or certificate."
    ;;
  secrets/*|*/secrets/*)
    deny "Blocked: files under a secrets/ directory."
    ;;
  # Everything below was denied for Bash by block-dangerous-bash.sh's SECRET_PATHS but
  # reachable through Read/Edit/Write, which is the gate this hook is. `cat ~/.claude.json`
  # was blocked while Read(~/.claude.json) returned the OAuth token into the transcript.
  # Of the set only ~/.config/gh/** had a settings deny standing behind it. Keep this list
  # and SECRET_PATHS in step — tests/hooks/protect-secrets.test.js fails if they drift.
  .claude.json|*/.claude.json)
    deny "Blocked: ~/.claude.json holds the Claude Code account OAuth token."
    ;;
  .git-credentials|*/.git-credentials)
    deny "Blocked: .git-credentials stores host credentials in plaintext."
    ;;
  */.kube/config|*/.docker/config.json|*/.config/gh/hosts.yml)
    deny "Blocked: this file holds cluster or registry credentials."
    ;;
  /etc/shadow|/etc/gshadow)
    deny "Blocked: system password database."
    ;;
  /proc/*/environ)
    deny "Blocked: /proc/<pid>/environ exposes another process's exported secrets."
    ;;
esac

exit 0
