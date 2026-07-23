#!/usr/bin/env bash
# allow-readonly-remote.sh
#
# PermissionRequest hook for Bash. Auto-approves read-only commands run on a
# remote host via `hl` (the homelab wrapper) or a plain `ssh [user@]host CMD`,
# so status/inspection calls (docker ps, uptime, journalctl, ...) don't prompt
# every time. Anything not provably read-only is left to normal handling (the
# ask rules); executable_block-dangerous-bash.sh stays the PreToolUse deny
# backstop for destructive remote payloads (sudo/rm -rf/reboot/...).
#
# "Read-only" is deliberately narrow: the outer command must be exactly `hl` or
# `ssh` (no chaining, redirection, or substitution), and the REMOTE command's
# verb must be on the allowlist below. docker/systemctl must name a read-only
# subcommand. Secret-file reads and log-deleting journalctl flags are refused
# even when the verb matches, since those exfiltrate or mutate.

set -u

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
[ -z "$COMMAND" ] && exit 0

# Any shell metacharacter can smuggle a second command past the verb check
# (`hl uptime; rm -rf /`) or redirect output (`hl cat x > y`); a pipe/subst can
# hide an unlisted command. Refuse to auto-approve if the raw command carries
# one — it just falls through to a normal prompt.
case $COMMAND in
  *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'$'* | *'`'* | *'('* | *')'* | *'{'* | *'}'* | *\\* | *$'\n'* )
    exit 0 ;;
esac

# Metachars are ruled out, so quotes are pure grouping — strip them and split on
# whitespace (`hl journalctl -u "my svc"` -> tokens hl journalctl -u my svc).
STRIPPED=${COMMAND//\"/}
STRIPPED=${STRIPPED//\'/}
read -ra TOK <<<"$STRIPPED"
[ "${#TOK[@]}" -eq 0 ] && exit 0

# Identify the wrapper and where the remote command begins.
bin=${TOK[0]##*/}   # basename, so an absolute path to hl/ssh still matches
case $bin in
  hl) start=1 ;;
  ssh)
    # Only the canonical `ssh [user@]host CMD...` form. Bail on any option
    # (-i/-p/-o/...) so an option value is never mistaken for the remote verb.
    [ "${#TOK[@]}" -lt 3 ] && exit 0
    [[ ${TOK[1]} == -* ]] && exit 0
    start=2 ;;
  *) exit 0 ;;
esac

# No remote command means an interactive shell — not read-only, let it prompt.
[ "${#TOK[@]}" -le "$start" ] && exit 0
REMOTE=("${TOK[@]:$start}")
verb=${REMOTE[0]}
sub=${REMOTE[1]:-}
rest="${REMOTE[*]}"

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
  exit 0
}

# Reading a secret path (even with `cat`) exfiltrates it into the transcript.
SECRET_RE='(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|\.pypirc|\.npmrc|/secrets/|\.pem($|[^a-z])|\.key($|[^a-z])|\.p12($|[^a-z])|\.pfx($|[^a-z]))'
printf '%s' "$rest" | grep -qiE "$SECRET_RE" && exit 0
# journalctl reads logs, but these flags delete or rotate them.
if [ "$verb" = journalctl ]; then
  printf '%s' "$rest" | grep -qE -- '--(vacuum-(size|time|files)|rotate|flush|sync|relinquish-var)' && exit 0
fi

third=${REMOTE[2]:-}
case $verb in
  uptime|uptimed|whoami|hostname|id|date|uname|arch|pwd|env|printenv|which|type|command|\
  df|free|du|ps|top|htop|vmstat|iostat|w|who|last|lscpu|lsblk|lsof|lsmod|dmesg|\
  sensors|nvidia-smi|getent|mount|\
  ls|cat|head|tail|wc|stat|file|tree|readlink|realpath|basename|dirname|\
  grep|egrep|fgrep|rg|echo|printf|sort|uniq|cut|tr|jq|xxd|od|\
  md5sum|sha1sum|sha256sum|cksum|\
  ip|ss|netstat|ping|ping6|dig|host|nslookup|traceroute|tracepath|\
  journalctl)
    allow ;;
  docker)
    case $sub in
      ps|logs|inspect|images|stats|version|info|top|port|diff|history|events|search)
        allow ;;
      network|volume|context|node) case $third in ls|inspect) allow ;; esac ;;
      container) case $third in ls|inspect|logs|top|stats|port|diff) allow ;; esac ;;
      image) case $third in ls|inspect|history) allow ;; esac ;;
      system) case $third in df|info|events) allow ;; esac ;;
      compose) case $third in ps|logs|config|images|top) allow ;; esac ;;
      service) case $third in ls|ps|inspect|logs) allow ;; esac ;;
      stack) case $third in ls|ps|services) allow ;; esac ;;
    esac
    ;;
  systemctl)
    case $sub in
      status|is-active|is-enabled|is-failed|list-units|list-unit-files|show|cat|\
      get-default|list-timers|list-sockets|list-dependencies|list-jobs|\
      is-system-running|show-environment)
        allow ;;
    esac
    ;;
esac

# Not provably read-only → defer to normal permission handling.
exit 0
