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

# Normalized copy for the whole-string checks below: collapse newline/tab/backslash
# (so a `\`-continuation can't split a binary from its verb, or a flag from its
# target) and drop quote characters, which are grouping rather than content —
# without this, `rm -rf "$HOME"` reads as `rm -rf "$HOME"` and slips past the
# `\s\$HOME` anchor that catches the unquoted form.
SCAN=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ' | tr -d "\"'")

# Catastrophic rm targets: root, root-with-a-glob (`rm -rf /*` erases the same tree
# but leaves no whitespace after the slash), home tilde, and $HOME.
#
# Every home form carries the `/?(\s|\*|$)` terminator so the match stops AT the home
# directory: `rm -rf ~` and `rm -rf $HOME/` are caught, `rm -rf $HOME/dev/build` is
# not. Without it, quote-stripping in SCAN exposes `$HOME` in every path beneath home
# and the hook denies ordinary work like `rm -rf "$HOME/dev/build"`.
HOME_TAIL='/?(\s|\*|$)'
RM_TARGET="(\\s/[[:space:]]|\\s/\$|\\s/\\*|\\s~$HOME_TAIL|\\s\\\$HOME$HOME_TAIL"
# ...and the home path written out in full (`rm -rf /home/you`), which none of the
# anchors above match.
if [ -n "${HOME:-}" ]; then
  HOME_RE=$(printf '%s' "$HOME" | sed 's/[][\\.*^$+?(){}|]/\\&/g')
  RM_TARGET="$RM_TARGET|\\s$HOME_RE$HOME_TAIL"
fi
RM_TARGET="$RM_TARGET)"

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
# `hl` is covered too: allow-readonly-remote.sh auto-approves read-only `hl` verbs and
# leans on this block as its deny backstop, but the backstop only ever matched `ssh`,
# so a destructive `hl` payload degraded from denied to merely prompted.
#
# The wrapper must be in command position. Matching it after any whitespace treated
# every command that merely mentions ssh as a remote invocation, then scanned the whole
# string — so `sudo systemctl status ssh` was denied as "sudo inside an ssh command".
if echo "$COMMAND" | grep -qiE '(^|[;&|(])[[:space:]]*([^[:space:];&|()]*/)?(ssh|hl)([[:space:]]|$)'; then
  # SCAN already stripped quotes and collapsed newline/tab/backslash, so payload
  # words have clean boundaries: `ssh h 'sudo rm -rf /'` -> `ssh h sudo rm -rf /`.
  REMOTE="$SCAN"
  ssh_hint="Run privileged or destructive remote commands in a direct session on the server, not from an agent session."
  echo "$REMOTE" | grep -qiE '\bsudo\b' && deny "Blocked: sudo inside a remote (ssh/hl) command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '(^|[[:space:]])su[[:space:]]+(-|root|[a-z_])' && deny "Blocked: su inside a remote (ssh/hl) command. $ssh_hint"
  echo "$REMOTE" | grep -qiE "\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b.*$RM_TARGET" && deny "Blocked: rm -rf of home/root on the remote host. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\bchown\b' && deny "Blocked: chown inside a remote (ssh/hl) command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\bchmod\s+(-[a-zA-Z]*\s+)*0?777\b' && deny "Blocked: chmod 777 inside a remote (ssh/hl) command. $ssh_hint"
  echo "$REMOTE" | grep -qiE '\b(reboot|poweroff|halt|shutdown)\b|\binit\s+[06]\b' && deny "Blocked: power-state change (reboot/shutdown/halt) on the remote host. $ssh_hint"
fi

# rm -rf targeting home or root (handles separated flags: rm -r -f /, rm --recursive --force /)
if echo "$SCAN" | grep -qiE "\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b.*$RM_TARGET"; then
  deny "Blocked: rm -rf targeting home or root directory. Use a specific path instead."
fi
if echo "$SCAN" | grep -qiE '\brm\s' && echo "$SCAN" | grep -qiE '(\s-[a-zA-Z]*r|\s--recursive)' && echo "$SCAN" | grep -qiE '(\s-[a-zA-Z]*f|\s--force)' && echo "$SCAN" | grep -qE "$RM_TARGET"; then
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

# Same payload as curl|sh via process or command substitution — `bash <(curl url)`,
# `sh -c "$(wget -O- url)"`, `eval "$(curl url)"`. No literal pipe, so the rules
# above (and permissions.deny) never see it. Match on the raw command: the quote
# stripping in SCAN would leave `$(` intact but the pattern reads either form.
# The interpreter list matches the secrets rule below, since `python3 -c "$(curl …)"`
# runs downloaded code just as `bash <(curl …)` does. `.` needs its own alternative —
# a bare dot has no word boundary to anchor on — and the downloader may be given by
# path, so `curl` is matched with an optional leading directory.
if echo "$COMMAND" | grep -qE '(\b(sh|bash|zsh|dash|fish|eval|source|python[0-9.]*|node|deno|bun|perl|ruby|php)\b|(^|[;&|(])[[:space:]]*\.[[:space:]])[^;&]*[<$]\([[:space:]]*([^[:space:]]*/)?(curl|wget)\b'; then
  deny "Blocked: executing downloaded content via process/command substitution. Download, inspect, then run."
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
# Best-effort: catches common readers, not obfuscated invocations.
# /proc/<pid>/environ and env-dumping paths belong here too — they carry exported
# tokens just as directly as a credentials file does.
SECRET_PATHS='(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.git-credentials|\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml|\.claude\.json|/etc/shadow|/etc/gshadow|/proc/[^/[:space:]]+/environ|\.pem|\.key|\.p12|\.pfx)'
# Content dumpers, searchers (grep/awk/sed), pagers, editors, hashers, and
# copy/exfil tools — any of these reading a secret path is a leak vector.
READERS='(cat|tac|nl|head|tail|less|more|most|bat|batcat|strings|xxd|hexdump|hd|od|base32|base64|uuencode|view|vi|vim|nvim|nano|emacs|ex|pico|grep|egrep|fgrep|rg|ag|ack|awk|gawk|mawk|sed|gpg|openssl|shasum|md5|md5sum|sha1sum|sha256sum|cp|install|rsync|scp|truncate|dd|tar|jq|yq|gojq|jaq)'
# Check every command segment, split on all separators: scanning only the args before
# the first pipe left `true | cat .env` unchecked, and splitting on `|` alone left
# anything chained after `;` or `&&` riding along inside a skipped segment.
#
# For a FILTERS command, drop that one leading pattern/filter argument before scanning.
# Dropping just the argument — rather than skipping the whole segment, as an earlier
# version did — is what keeps `ls | grep '\.pem'` from reading as a secret access while
# still catching `jq -r . ~/.aws/credentials`, which is why jq is in READERS above.
set -f   # $seg is deliberately word-split below; globbing it would rewrite the tokens
while IFS= read -r seg; do
  # shellcheck disable=SC2086  # word-splitting is intended here; globbing is off
  set -- $seg
  [ "$#" -eq 0 ] && continue
  case "${1##*/}" in
    grep|egrep|fgrep|rg|ag|ack|jq|yq|gojq|jaq)
      head=$1; shift
      while [ "$#" -gt 0 ]; do
        case $1 in -*) shift ;; *) shift; break ;; esac
      done
      seg="$head $*"
      ;;
  esac
  if printf '%s' "$seg" | grep -qE "\b$READERS\b.*$SECRET_PATHS"; then
    deny "Blocked: reading a secrets file via bash. Use a non-sensitive path or ask the user to share the specific value needed."
  fi
done <<< "$(printf '%s' "$COMMAND" | tr ';&|' '\n')"
set +f
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
TF_SCAN="$SCAN"
# The binary must be in command position (start, or after a separator, allowing leading
# env assignments). Matching it anywhere meant quote stripping exposed the words inside
# strings, so `git commit -m "document terraform apply steps"` was denied.
TF_AT='(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*'
# Destructive verb as the first token after the binary (optional global flags
# like -chdir=… in between). Also catches terragrunt apply-all/destroy-all,
# since the verb still appears as a whole word.
if echo "$TF_SCAN" | grep -qiE "$TF_AT$TF_BIN\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy|import|taint|untaint|force-unlock)\b"; then
  deny "Blocked: state-mutating/destructive terraform command (apply/destroy/import/taint/force-unlock). Use plan to preview; a human applies infra changes."
fi
# Terragrunt run-all / run [--all] <verb> (verb sits after run-all/run + flags)
if echo "$TF_SCAN" | grep -qiE "$TF_AT""terragrunt\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(run-all|run)([[:space:]]+(--all|-[^[:space:]]+))*[[:space:]]+(apply|destroy|import)\b"; then
  deny "Blocked: destructive terragrunt run-all/run command. Use plan to preview; a human applies infra changes."
fi
# state subcommands that rewrite or drop state (state list/show stay allowed)
if echo "$TF_SCAN" | grep -qiE "$TF_AT$TF_BIN\b.*\bstate[[:space:]]+(rm|mv|push|replace-provider)\b"; then
  deny "Blocked: terraform state mutation (state rm/mv/push/replace-provider). state list/show are fine; mutations must be done by a human."
fi
# workspace deletion drops that workspace's state
if echo "$TF_SCAN" | grep -qiE "$TF_AT$TF_BIN\b.*\bworkspace[[:space:]]+delete\b"; then
  deny "Blocked: terraform/tofu workspace delete drops its state."
fi
# any -auto-approve — never allow non-interactive apply/destroy
if echo "$TF_SCAN" | grep -qiE "$TF_AT$TF_BIN\b.*[[:space:]]--?auto-approve\b"; then
  deny "Blocked: terraform -auto-approve. Non-interactive apply/destroy is not permitted."
fi

exit 0
