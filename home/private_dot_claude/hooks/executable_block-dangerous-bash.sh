#!/bin/bash
# PreToolUse hook for Bash: deny patterns that are usually mistakes.
# Returns a structured PreToolUse decision via JSON on stdout.

# Body is mostly single-quoted grep regexes (literal $, \s, \b) plus a tr that
# collapses literal backslashes — both are intentional and trip SC2016/SC1003 as
# false positives, so disable those two info checks for the whole file.
# shellcheck disable=SC2016,SC1003
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

# Remote-exec guardrail (ssh): the permission engine matches only the OUTER
# command, so `ssh host '<payload>'` reads as a bare `ssh` — the deny list
# (sudo/su/chown/…) never sees what runs on the far host, and the surrounding
# quotes hide the payload from the checks below (the rm -rf path anchor breaks on
# `ssh h 'rm -rf /'`, which ends in /'). Re-scan the payload so an agent can't do
# over ssh what it's denied locally. Deploys are unaffected: they carry no literal
# sudo (ansible uses become: internally). mkfs/dd/terraform/fork-bomb are already
# caught whole-string below; this closes only the quoting/prefix-match gaps.
if echo "$COMMAND" | grep -qiE '(^|[[:space:];&|(/])ssh([[:space:]]|$)'; then
  # Strip quotes and collapse newline/tab/backslash so payload words regain clean
  # boundaries: `ssh h 'sudo rm -rf /'` -> `ssh h sudo rm -rf /`.
  REMOTE=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ' | tr -d "\"'")
  ssh_hint="Run privileged or destructive remote commands in a direct session on the server, not over ssh from an agent session."
  echo "$REMOTE" | grep -qiE '\bsudo\b' && deny "Blocked: sudo inside an ssh command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '(^|[[:space:]])su[[:space:]]+(-|root|[a-z_])' && deny "Blocked: su inside an ssh command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b.*(\s/[[:space:]]|\s/$|\s~|\s\$HOME)' && deny "Blocked: rm -rf of home/root on the remote host. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\bchown\b' && deny "Blocked: chown inside an ssh command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\bchmod\s+(-[a-zA-Z]*\s+)*0?777\b' && deny "Blocked: chmod 777 inside an ssh command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\b(reboot|poweroff|halt|shutdown)\b|\binit\s+[06]\b' && deny "Blocked: power-state change (reboot/shutdown/halt) on the remote host. $ssh_hint"
fi

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

# Terraform / OpenTofu / Terragrunt — deny state-mutating & destructive ops.
# Scan a NORMALIZED copy of the whole command: collapse newline/tab/backslash
# (defeats `\`-continuation splitting the binary from its verb across lines)
# and strip quote chars (defeats `"terraform" apply` / `terraform" "apply`),
# then grep. Catches compound/prefixed forms too (`cd x && terraform destroy`,
# `AWS_PROFILE=p tofu apply`). NOTE: static string-scanning cannot catch
# indirection (xargs/eval/$VAR) or write-a-script-then-run — see review notes.
# Read-only ops stay allowed: plan, validate, fmt, show, output, providers,
# graph, init, get, state list/show, workspace list/select.
TF_BIN='(terraform|tofu|terragrunt)'
TF_SCAN=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ' | tr -d "\"'")
# Destructive verb as the first token after the binary (optional global flags
# like -chdir=… in between). Also catches terragrunt apply-all/destroy-all,
# since the verb still appears as a whole word.
if echo "$TF_SCAN" | grep -qiE "\b$TF_BIN\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy|import|taint|untaint|force-unlock)\b"; then
  deny "Blocked: state-mutating/destructive terraform command (apply/destroy/import/taint/force-unlock). Use plan to preview; a human applies infra changes."
fi
# Terragrunt run-all / run [--all] <verb> (verb sits after run-all/run + flags)
if echo "$TF_SCAN" | grep -qiE "\bterragrunt\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(run-all|run)([[:space:]]+(--all|-[^[:space:]]+))*[[:space:]]+(apply|destroy|import)\b"; then
  deny "Blocked: destructive terragrunt run-all/run command. Use plan to preview; a human applies infra changes."
fi
# state subcommands that rewrite or drop state (state list/show stay allowed)
if echo "$TF_SCAN" | grep -qiE "\b$TF_BIN\b.*\bstate[[:space:]]+(rm|mv|push|replace-provider)\b"; then
  deny "Blocked: terraform state mutation (state rm/mv/push/replace-provider). state list/show are fine; mutations must be done by a human."
fi
# workspace deletion drops that workspace's state
if echo "$TF_SCAN" | grep -qiE "\b$TF_BIN\b.*\bworkspace[[:space:]]+delete\b"; then
  deny "Blocked: terraform/tofu workspace delete drops its state."
fi
# any -auto-approve — never allow non-interactive apply/destroy
if echo "$TF_SCAN" | grep -qiE "\b$TF_BIN\b.*[[:space:]]--?auto-approve\b"; then
  deny "Blocked: terraform -auto-approve. Non-interactive apply/destroy is not permitted."
fi

exit 0
