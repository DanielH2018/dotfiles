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
  if echo "$COMMAND" | grep -qE '(^|[[:space:]]|:)(main|master)([[:space:]]|:|$)'; then
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

# Reading secret files via bash commands (bypasses Read deny rules).
# Args before the first pipe only, so a trailing jq/grep filter like '.key' isn't
# misread as a path. Best-effort: catches common readers, not obfuscated invocations.
SECRET_PATHS='(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.pem|\.key|\.p12|\.pfx)'
# Content dumpers, searchers (grep/awk/sed), pagers, editors, hashers, and
# copy/exfil tools — any of these reading a secret path is a leak vector.
READERS='(cat|tac|nl|head|tail|less|more|most|bat|batcat|strings|xxd|hexdump|hd|od|base32|base64|uuencode|view|vi|vim|nvim|nano|emacs|ex|pico|grep|egrep|fgrep|rg|ag|ack|awk|gawk|mawk|sed|gpg|openssl|shasum|md5|md5sum|sha1sum|sha256sum|cp|install|rsync|scp|truncate|dd|tar)'
CMD_ARGS="${COMMAND%%|*}"
if echo "$CMD_ARGS" | grep -qE "\b$READERS\b.*$SECRET_PATHS"; then
  deny "Blocked: reading a secrets file via bash. Use a non-sensitive path or ask the user to share the specific value needed."
fi
# Interpreters that can slurp a file (python -c 'open(".env")', node -e, perl, ...).
# Scan the whole command; requiring an interpreter keyword keeps jq '.key' from tripping.
if echo "$COMMAND" | grep -qE "\b(python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript|osascript)\b.*$SECRET_PATHS"; then
  deny "Blocked: reading a secrets file via an interpreter. Ask the user to share the specific value needed."
fi

# Writing to secret paths via pipe (tee) or redirection — check the full command
if echo "$COMMAND" | grep -qE "(>|tee\s+)\s*~?/?$SECRET_PATHS"; then
  deny "Blocked: writing to a secrets file via pipe/redirect. Ask the user to do this manually."
fi

exit 0
