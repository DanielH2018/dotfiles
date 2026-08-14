#!/usr/bin/env bash
# allow-daniel-server.sh
#
# PermissionRequest hook for Bash. Auto-approves ANY command run on a homelab host
# via `ssh <host> CMD` — read-only or not. This is a deliberate widening of
# allow-readonly-remote.sh, which only ever approves a provably read-only verb.
#
# Why a hook and not a permission rule: `Bash(ssh:*)` sits in the `ask` list, and
# rules are evaluated deny -> ask -> allow with the first match winning, so an
# `allow` entry like `Bash(ssh daniel-server:*)` would never be reached. Only a
# PermissionRequest hook resolves an ask rule.
#
# Scope is deliberately the two homelab hosts below. Every other ssh target keeps
# the ask prompt.
#
# NOT a full bypass: block-dangerous-bash.sh is a PreToolUse hook that re-scans the
# remote payload and exits 2 on sudo/rm -rf/reboot/..., and a blocking hook runs
# before permission rules are evaluated. Those stay denied regardless of this file.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[ -z "$COMMAND" ] && exit 0

# A metacharacter can chain a second command that never reaches daniel-server
# (`ssh daniel-server uptime; rm -rf ~`) or redirect output locally. The remote
# payload is unrestricted by design, but the LOCAL command line must be exactly
# one plain `ssh` invocation, so anything that could split it falls through to a
# prompt.
#
# Which metacharacters matter depends on QUOTING, not on presence. A `;` inside
# the quoted payload is one more byte handed to sshd; the same `;` outside the
# quotes starts a local command. Scanning the raw string for either treats them
# alike, and that is what made `ssh daniel-server "cd /repo; git status"` prompt
# -- 67 of the 361 ssh prompts measured over the week of 2026-08-07, all of them
# the `cd`-prefix idiom that `ssh-lands-in-home-not-repo` tells us to write.
#
# So walk the string tracking quote state and judge each character in context:
#   outside quotes  -- ; & | < > ( ) $ ` newline all split or expand locally
#   in "double"     -- $ and ` still expand LOCALLY before ssh runs; the rest are
#                      literal bytes in the payload
#   in 'single'     -- nothing expands; every byte is payload
# A backslash escapes the next character everywhere but inside single quotes, so
# consume the pair rather than letting `\"` desynchronise the quote tracking. An
# unterminated quote means the parse is not trustworthy: fall through to a prompt.
local_split_risk() {
  local s=$1 i c q='' n=${#1}
  for ((i = 0; i < n; i++)); do
    c=${s:i:1}
    if [ "$q" = "'" ]; then
      [ "$c" = "'" ] && q=''
      continue
    fi
    if [ "$q" = '"' ]; then
      case $c in
        [\\]) ((i++)) ;;
        '"') q='' ;;
        '$' | '`') return 0 ;;
      esac
      continue
    fi
    case $c in
      [\\]) ((i++)) ;;
      "'" | '"') q=$c ;;
      ';' | '&' | '|' | '<' | '>' | '(' | ')' | '$' | '`' | $'\n') return 0 ;;
    esac
  done
  [ -z "$q" ] || return 0
  return 1
}
local_split_risk "$COMMAND" && exit 0

# Local splitting is ruled out, so quotes are pure grouping.
STRIPPED=${COMMAND//\"/}
STRIPPED=${STRIPPED//\'/}
read -ra TOK <<<"$STRIPPED"
[ "${#TOK[@]}" -lt 3 ] && exit 0

# Basename, so an absolute path to ssh still matches.
[ "${TOK[0]##*/}" = ssh ] || exit 0

# Bail on any option so an option value is never mistaken for the host, and so
# forwarding/proxy flags (-L/-R/-D/-o ProxyCommand=) can't ride along.
[[ ${TOK[1]} == -* ]] && exit 0

# Exact host match only. Substring matching would let `daniel-server-backup` or
# `notdaniel-server` through; strip an optional `user@` first.
host=${TOK[1]#*@}
case $host in
  daniel-server|daniel-pi) ;;
  *) exit 0 ;;
esac

# Refuse a second hop — these two hosts are all this file speaks for, and
# `ssh daniel-server ssh other-host ...` lands somewhere else entirely.
#
# Every payload token, not just the first: once a `;` inside the quotes is
# allowed through, `ssh daniel-server "cd /tmp; ssh other-host ..."` puts the
# hop in second position, where checking TOK[2] alone would miss it. Scanning
# the whole payload also refuses a hop reached as an argument
# (`docker exec c rsync ...`), which is the safe direction for a file whose
# entire claim is "these two hosts".
for ((t = 2; t < ${#TOK[@]}; t++)); do
  case ${TOK[t]##*/} in
    ssh|hl|scp|sftp|rsync) exit 0 ;;
  esac
done

printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
exit 0
