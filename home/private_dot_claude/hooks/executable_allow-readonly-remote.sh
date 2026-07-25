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
# hide an unlisted command. Glob chars (*?[]) let a literal that doesn't match
# SECRET_RE below (e.g. `/proc/self/enviro?`) expand into a secret path once
# the remote shell glob-expands it. Refuse to auto-approve if the raw command
# carries one — it just falls through to a normal prompt.
case $COMMAND in
  *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'$'* | *'`'* | *'('* | *')'* | *'{'* | *'}'* | \
  *'*'* | *'?'* | *'['* | *']'* | *\\* | *$'\n'* )
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
# /proc/<pid>/environ dumps the process environment — every exported token — and is
# world-readable to its own user, so it is the practical form of this attack rather
# than a root-only file like /etc/shadow.
# \.ssh, \.gnupg and /secrets match without a trailing slash too, since
# `grep -r x /home/ubuntu/.ssh` reads the whole directory (every key) without
# ever writing a slash after it.
SECRET_RE='(\.env|\.ssh(/|[[:space:]]|$)|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg(/|[[:space:]]|$)|\.netrc|\.pypirc|\.npmrc|/secrets(/|[[:space:]]|$)|\.git-credentials|\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml|\.config/gcloud/|\.config/rclone/rclone\.conf|terraform\.tfstate|\.bash_history|\.claude\.json|/etc/shadow|/etc/gshadow|/proc/[^[:space:]]*environ|\.pem($|[^a-z])|\.key($|[^a-z])|\.p12($|[^a-z])|\.pfx($|[^a-z]))'
printf '%s' "$rest" | grep -qiE "$SECRET_RE" && exit 0
# journalctl reads logs, but these flags delete or rotate them.
if [ "$verb" = journalctl ]; then
  printf '%s' "$rest" | grep -qE -- '--(vacuum-(size|time|files)|rotate|flush|sync|relinquish-var)' && exit 0
fi
# dmesg reads the kernel ring buffer, but these flags clear it.
if [ "$verb" = dmesg ]; then
  printf '%s' "$rest" | grep -qE -- '(^| )-[a-zA-Z]*[Cc][a-zA-Z]*($| )|--clear|--read-clear' && exit 0
fi
# ss lists sockets, but -K/--kill closes them.
if [ "$verb" = ss ]; then
  printf '%s' "$rest" | grep -qE -- '(^| )-[a-zA-Z]*K[a-zA-Z]*($| )|--kill' && exit 0
fi

third=${REMOTE[2]:-}
# env/printenv are deliberately absent from this list: they print every exported
# variable, which on a homelab host includes API tokens. They read as "read-only"
# but are an exfiltration path, so they fall through to a normal prompt.
# `command` is a shell builtin on the remote that executes its argument, so
# having it here would launder any verb past this allowlist. `mount` (with no
# args, or writing fstab) mutates, and `sort -o`/`uniq [IN OUT]`/`xxd -r [IN
# OUT]` all take an output file, so none of the three belong on a read-only list.
case $verb in
  uptime|uptimed|whoami|hostname|id|date|uname|arch|pwd|which|type|\
  df|free|du|ps|top|htop|vmstat|iostat|w|who|last|lscpu|lsblk|lsof|lsmod|dmesg|\
  sensors|nvidia-smi|getent|\
  ls|cat|head|tail|wc|stat|file|tree|readlink|realpath|basename|dirname|\
  grep|egrep|fgrep|rg|echo|printf|cut|tr|jq|od|\
  md5sum|sha1sum|sha256sum|cksum|\
  ss|netstat|ping|ping6|dig|host|nslookup|traceroute|tracepath|\
  journalctl)
    allow ;;
  ip)
    # Only inspection subcommands are read-only ("ip a", "ip route", "ip addr
    # show"); anything else ("ip link set", "ip addr add", ...) mutates.
    case $third in ''|show|list|ls|get) allow ;; esac
    ;;
  docker)
    # inspect/config are excluded here (and below) because they print the
    # container/compose Env[], the same secret-dumping shape as `env`.
    case $sub in
      ps|logs|images|stats|version|info|top|port|diff|history|events|search)
        allow ;;
      network|volume|context|node) case $third in ls|inspect) allow ;; esac ;;
      container) case $third in ls|logs|top|stats|port|diff) allow ;; esac ;;
      image) case $third in ls|history) allow ;; esac ;;
      system) case $third in df|info|events) allow ;; esac ;;
      compose) case $third in ps|logs|images|top) allow ;; esac ;;
      service) case $third in ls|ps|logs) allow ;; esac ;;
      stack) case $third in ls|ps|services) allow ;; esac ;;
    esac
    ;;
  systemctl)
    # show/cat/show-environment print unit `Environment=` values — same
    # secret-dumping shape as `env`, so they're excluded like docker inspect above.
    case $sub in
      status|is-active|is-enabled|is-failed|list-units|list-unit-files|\
      get-default|list-timers|list-sockets|list-dependencies|list-jobs|\
      is-system-running)
        allow ;;
    esac
    ;;
esac

# Not provably read-only → defer to normal permission handling.
exit 0
