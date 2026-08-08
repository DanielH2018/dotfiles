#!/usr/bin/env bash
# allow-daniel-server.sh
#
# PermissionRequest hook for Bash. Auto-approves ANY command run on daniel-server
# via `ssh daniel-server CMD` — read-only or not. This is a deliberate widening of
# allow-readonly-remote.sh, which only ever approves a provably read-only verb.
#
# Why a hook and not a permission rule: `Bash(ssh:*)` sits in the `ask` list, and
# rules are evaluated deny -> ask -> allow with the first match winning, so an
# `allow` entry like `Bash(ssh daniel-server:*)` would never be reached. Only a
# PermissionRequest hook resolves an ask rule.
#
# Scope is deliberately one host. Every other ssh target keeps the ask prompt.
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
# prompt. Note this is the outer string: `ssh daniel-server "rm -rf /tmp/x"` has
# no metacharacter and is approved, which is the point.
case $COMMAND in
  *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'$'* | *'`'* | *'('* | *')'* | *$'\n'* )
    exit 0 ;;
esac

# Metachars are ruled out, so quotes are pure grouping.
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
[ "$host" = daniel-server ] || exit 0

# Refuse a second hop — daniel-server is the only host this file speaks for, and
# `ssh daniel-server ssh other-host ...` lands somewhere else entirely.
case ${TOK[2]##*/} in
  ssh|hl|scp|sftp|rsync) exit 0 ;;
esac

printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
exit 0
