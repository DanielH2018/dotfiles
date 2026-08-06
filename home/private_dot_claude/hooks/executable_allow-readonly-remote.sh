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

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[ -z "$COMMAND" ] && exit 0

# --- outer command: shared cmd_parse library ---------------------------------------------
#
# Chaining/substitution/heredoc in the OUTER (local) command used to be ruled out by a raw
# character ban on the whole string (`;`/`&`/`|`/`` ` ``/`$`/`(`/`)`/newline). cmd_parse
# replaces that: it is quote- and escape-aware, where the raw ban was not (an unbalanced
# quote fell through to the strip-and-split below with no check at all). A `hl`/`ssh`
# invocation must locally be exactly one command, with no local substitution and no
# heredoc — no consumer here reads CP_SUBSEG or a heredoc body, so either is an automatic
# defer, same as the raw ban treated them.
#
# CMDPARSE=off is the rollback lever: with it set, or if the library cannot be sourced,
# this hook always defers.
if [ "${CMDPARSE:-on}" = off ]; then
  exit 0
fi
# shellcheck source=/dev/null
. "${CMDPARSE_LIB:-${BASH_SOURCE[0]%/*}/cmdparse.sh}" 2>/dev/null || exit 0
cmd_parse "$COMMAND" || exit 0
[ "$CP_NSEG" -eq 1 ] || exit 0
[ "$CP_NSUBSEG" -eq 0 ] || exit 0
[ -z "${CP_HEREDOC[0]}" ] || exit 0

# What is left is out of cmd_parse's scope by design (its own header: "this slice
# deliberately stops at segmentation") and stays a raw character ban on the whole command,
# unchanged: redirection (`<`/`>` — cmd_parse does not model redirects, and an unquoted `>`
# is consumed by the LOCAL shell, not passed to the remote command, so treating it as a
# remote argument would be a correctness bug, not just a policy one), glob chars (`*?[]` —
# the remote shell expands these, see SECRET_RE below), backslash (kept out of the
# tokenizer's scope entirely, for simplicity), and a literal newline. A newline is
# genuinely a local separator to cmd_parse (correctly inert when quoted, same as `;`), but
# it cannot be deferred to the remote-text recheck below the way `;`/`&`/`|` are: `read -ra`
# a few lines down splits on IFS, which treats a newline exactly like a space, so a quoted
# newline is gone by the time `$rest` exists to check it. A quoted newline is exactly the
# same hazard as a quoted `;` once ssh joins argv into one string for the remote shell to
# reparse (`hl echo "a<NEWLINE>rm -rf /"` sends `echo a` and `rm -rf /` as two remote
# commands) — so it stays banned here instead, unconditionally, same as today.
case $COMMAND in
  *'<'* | *'>'* | *'{'* | *'}'* | *'*'* | *'?'* | *'['* | *']'* | *\\* | *$'\n'* )
    exit 0 ;;
esac

# cmd_parse confirmed the quoting balances, so stripping quote characters and splitting on
# whitespace is now safe (`hl journalctl -u "my svc"` -> tokens hl journalctl -u my svc).
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

# The remote command TEXT gets the same ban the whole command used to carry, even though
# cmd_parse already proved these characters are locally quoted (harmless to THIS shell).
# ssh concatenates argv and hands the string to a remote shell that reparses it from
# scratch, ignoring how it was quoted here -- `ssh host "ls; rm -rf /"` is one local
# argument but two remote commands. $rest is built from TOK, already quote-stripped above,
# so this sees exactly the dequoted content the remote shell would.
case $rest in
  *';'* | *'&'* | *'|'* | *'`'* | *'$'* | *'('* | *')'* )
    exit 0 ;;
esac

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
