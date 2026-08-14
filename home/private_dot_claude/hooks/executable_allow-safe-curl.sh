#!/usr/bin/env bash
# allow-safe-curl.sh
#
# PermissionRequest hook for Bash. Auto-approves a `curl` that is provably a plain
# GET/HEAD against a host on the allowlist below, so polling a local service (a
# Prometheus query, a container's /health, a dev server) stops prompting every
# time. Anything else produces no decision and falls through to the `Bash(curl:*)`
# ask rule.
#
# curl sits in the ask list because it takes an arbitrary URL and can write the
# response to disk, so the two things this hook has to establish are that every URL
# names an allowlisted host and that no option can undo that. A permission prefix
# rule cannot do either: `Bash(curl http://10.0.0.161/:*)` constrains nothing after
# the URL, and `curl http://10.0.0.161/x -o ~/.ssh/authorized_keys` matches it.
#
# The option table is an ALLOWLIST. curl gains options every release, so a list of
# refusals goes stale silently -- it is only ever evidence about the options someone
# thought of. An option this script does not name, old or new, is not a decision.
#
# The ones that would make host-checking a lie are absent for that reason and would
# each defeat the allowlist on their own: --resolve and --connect-to remap the name
# to a different address, -x/--proxy makes the URL host cosmetic, --unix-socket
# ignores it entirely, -K/--config reads `url` and `output` out of a file the way a
# remote `command` launders a verb, --next starts a second request with fresh
# options, and -L/--location lets an allowlisted host redirect the fetch anywhere.
# Absent too: every write primitive (-o, -O, --output-dir, -J, -D, --trace*,
# --stderr, --create-dirs) and every read-a-file-into-the-request primitive (-d
# @file, --data-binary, -F, -T, -b), which is what ask-listing curl was protecting
# against in the first place.
#
# -k/--insecure IS allowed: it weakens TLS verification, but only for a connection
# this script has already pinned to an allowlisted host, and the homelab services
# behind these addresses serve self-signed certs.
#
# A URL carrying a query string has to be quoted (`curl "http://10.0.0.161:9090/
# api/v1/query?query=up"`). An unquoted `?` or `&` is refused, because the shell
# expands the command AFTER this hook approves the text -- see tokenize() below.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[[ -z $COMMAND ]] && exit 0

# Exact hosts, matched whole. Loopback plus the three machines in ~/.ssh/config.
# Add a host by adding a line here -- there is deliberately no env var or config
# file for this list, because either one would be a way to widen it from outside.
ALLOWED_HOSTS=(
  localhost
  127.0.0.1
  '[::1]'
  10.0.0.161  # homelab / daniel-server
  10.0.0.139  # daniel-pi
  10.0.0.215  # daniel-box
)

# `G` builds the accumulated --data-* into the query string, turning what would be a
# POST into a GET -- see the SAW_DATA gate at the bottom.
#
# `o` is the one write primitive in these tables, and it is admitted ONLY for the
# literal value /dev/null (pinned in check_value). The header's rule that write
# options stay out is about curl putting a response on disk; `-o /dev/null` is how
# you discard one. It earns the exception on volume: 97 curl calls in the week of
# 2026-08-07 carried `-o /dev/null`, every one of them a status probe with a `-w`
# format containing %{http_code}, and 67 were refused for this option alone. There is
# no already-admitted substitute -- `-I` still prints the response headers, so it
# does not give you a bare status line.
#
# Note what this exception is NOT: every other entry in these tables admits a CLASS of
# values (-H any header, -m any number). This one admits a single literal string, so
# `curl -o ~/.ssh/authorized_keys ...` is still refused. -O, --output-dir, -J, -D and
# the rest stay out entirely; the structure test pins that.
BOOL_SHORT='sSfiIvkg46N#G'
VALUE_SHORT='HAmwreXo'

# Split COMMAND into TOKENS. Any shell-special character OUTSIDE quotes is a
# refusal, which is what makes the rest of this script's reading of the command the
# same as the shell's: it covers chaining (`;` `&` `&&`), pipes, redirection,
# substitution (`$` and backtick, inside double quotes too), grouping, a leading
# `~`, and the glob characters. Globs matter for the same reason as the rest: the
# shell expands them after the decision is made, so `curl http://10.0.0.161/a*`
# could reach curl as arguments this script never validated. Inside quotes all of
# these are literal, so a quoted query string is fine.
NTOK=0
tokenize() {
  local s=$1
  local n=${#s} i=0 c state='' cur='' started=''
  NTOK=0
  while ((i < n)); do
    c=${s:i:1}
    i=$((i + 1))
    case $state in
      '')
        case $c in
          ' ' | $'\t')
            if [[ -n $started ]]; then
              TOKENS[NTOK]=$cur
              NTOK=$((NTOK + 1))
              cur=''
              started=''
            fi
            ;;
          "'") state=single; started=1 ;;
          '"') state=double; started=1 ;;
          ';' | '&' | '|' | '<' | '>' | '(' | ')' | '{' | '}' | '$' | '`' | \\ | \
            '*' | '?' | '[' | ']' | $'\n' | $'\r')
            return 1 ;;
          '~')
            # Only expands at the start of a word; mid-URL it is an ordinary path char.
            [[ -z $started ]] && return 1
            cur+=$c ;;
          *) cur+=$c; started=1 ;;
        esac
        ;;
      single)
        if [[ $c == "'" ]]; then state=''; else cur+=$c; fi
        ;;
      double)
        # Inside double quotes bash treats `\` as an escape ONLY before $ ` " \ and a
        # newline; before anything else both characters stay literal. Refusing every
        # backslash outright was therefore rejecting inert text -- and the text it hit
        # was `-w "%{http_code}\n"`, the trailing newline on a status probe, which is
        # why the single-quoted spelling of the same command was approved and the
        # double-quoted one was not. 63 of the week's curl prompts died here.
        #
        # Following bash exactly is also the safer reading, not a relaxation: an
        # ESCAPED $ or backtick cannot expand, so consuming the pair removes a
        # substitution this loop would otherwise have to refuse. Consuming `\"` is what
        # keeps quote tracking in step with the shell; an unescaped $ or ` still bails.
        case $c in
          '"') state='' ;;
          '$' | '`') return 1 ;;
          \\)
            case ${s:i:1} in
              '$' | '`' | '"' | \\ | $'\n')
                cur+=${s:i:1}
                i=$((i + 1)) ;;
              *) cur+=$c ;;
            esac ;;
          *) cur+=$c ;;
        esac
        ;;
    esac
  done
  [[ -n $state ]] && return 1
  if [[ -n $started ]]; then
    TOKENS[NTOK]=$cur
    NTOK=$((NTOK + 1))
  fi
  return 0
}

# The exact list above is pre-k3s: it names the three physical machines, which is
# where every service used to answer. Since the 2026-08-14 migration a workload is
# reachable at a ClusterIP (10.43/16), a pod IP (10.42/16), or an ingress hostname
# under daniel-hunter.com -- and none of those could ever match an exact entry, so
# this hook approved ZERO curl calls in the week of 2026-08-07 while 148 prompted.
#
# These two arms are patterns, not literals, which is a real widening of what the
# list can express. Both are bounded to keep it honest:
#   * the CIDRs are the cluster's own private ranges, and each octet is checked
#     numerically so `10.43.0.0.evil.com` cannot pass as an address;
#   * the domain match is ANCHORED to the end (`*.daniel-hunter.com`), so
#     `daniel-hunter.com.attacker.net` does not match -- the classic hole here.
# Still no env var and no config file: widening stays an edit to this file.
host_allowed() {
  local candidate=$1 allowed
  for allowed in "${ALLOWED_HOSTS[@]}"; do
    [[ $candidate == "$allowed" ]] && return 0
  done
  local o='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  [[ $candidate =~ ^10\.4[23]\.$o\.$o$ ]] && return 0
  [[ $candidate == *.daniel-hunter.com ]] && return 0
  return 1
}

# The authority is everything after the scheme and before the first /?#, with any
# userinfo refused rather than skipped -- `http://10.0.0.161@evil.com/` connects to
# evil.com and beats any substring check of the URL text.
url_ok() {
  local url=$1 rest authority host port
  [[ $url =~ ^[Hh][Tt][Tt][Pp][Ss]?:// ]] || return 1
  rest=${url#*://}
  authority=${rest%%[/?#]*}
  [[ -z $authority ]] && return 1
  case $authority in *@*) return 1 ;; esac
  if [[ $authority == '['* ]]; then
    host=${authority%%]*}]
  else
    host=${authority%%:*}
  fi
  port=${authority#"$host"}
  if [[ -n $port ]]; then
    [[ $port == :* ]] || return 1
    port=${port#:}
    [[ $port =~ ^[0-9]+$ ]] || return 1
  fi
  host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
  host_allowed "$host"
}

long_bool() {
  case $1 in
    silent | show-error | fail | fail-early | fail-with-body | include | head | \
      verbose | insecure | compressed | globoff | ipv4 | ipv6 | http1.0 | http1.1 | \
      http2 | http2-prior-knowledge | no-buffer | no-progress-meter | progress-bar | \
      raw | tcp-nodelay | no-keepalive | path-as-is | retry-all-errors | \
      retry-connrefused | get)
      return 0 ;;
  esac
  return 1
}

long_value() {
  case $1 in
    header | user-agent | referer | max-time | connect-timeout | retry | \
      retry-delay | retry-max-time | range | max-filesize | write-out | request | \
      url | expect100-timeout | happy-eyeballs-timeout-ms | data-urlencode | output)
      return 0 ;;
  esac
  return 1
}

SAW_URL=0
SAW_GET=0
SAW_DATA=0

# A value starting with @ makes curl read a FILE (`-H @hdrs`, `-w @fmt`,
# `--data-urlencode @secrets`), which puts unvalidated content into the request;
# refuse those wherever a value is accepted. This one check is why admitting
# --data-urlencode does not reopen the read-a-file-into-the-request hole the header
# lists `-d @file` and --data-binary under.
check_value() {
  local name=$1 value=$2
  case $value in @*) return 1 ;; esac
  case $name in
    request | X)
      case $value in GET | HEAD | get | head) return 0 ;; *) return 1 ;; esac
      ;;
    url)
      url_ok "$value" || return 1
      SAW_URL=1
      ;;
    # The discard target and nothing else. Any other value is curl writing the response
    # to disk, which is what ask-listing curl was protecting against in the first place.
    # Both spellings land here: `o` from the short cluster, `output` from --output=VAL.
    output | o)
      [[ $value == /dev/null ]] || return 1
      ;;
    # Harmless on its own; it is a POST body unless -G moves it into the query
    # string, so the gate at the bottom is what makes admitting it safe.
    data-urlencode)
      SAW_DATA=1
      ;;
  esac
  return 0
}

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
  exit 0
}

tokenize "$COMMAND" || exit 0
((NTOK > 1)) || exit 0
# Basename, so an absolute path to curl still matches. curlie and other wrappers do
# not: they take their own options and this script has not read them.
[[ ${TOKENS[0]##*/} == curl ]] || exit 0

i=1
while ((i < NTOK)); do
  tok=${TOKENS[i]}
  i=$((i + 1))
  case $tok in
    --)
      exit 0 ;;
    --?*=*)
      name=${tok%%=*}
      name=${name#--}
      long_value "$name" || exit 0
      check_value "$name" "${tok#*=}" || exit 0
      ;;
    --?*)
      name=${tok#--}
      if long_bool "$name"; then
        [[ $name == get ]] && SAW_GET=1
        continue
      fi
      long_value "$name" || exit 0
      ((i < NTOK)) || exit 0
      value=${TOKENS[i]}
      i=$((i + 1))
      check_value "$name" "$value" || exit 0
      ;;
    -?*)
      cluster=${tok#-}
      j=0
      while ((j < ${#cluster})); do
        c=${cluster:j:1}
        j=$((j + 1))
        if [[ $BOOL_SHORT == *"$c"* ]]; then
          [[ $c == G ]] && SAW_GET=1
          continue
        fi
        [[ $VALUE_SHORT == *"$c"* ]] || exit 0
        value=${cluster:j}
        if [[ -z $value ]]; then
          ((i < NTOK)) || exit 0
          value=${TOKENS[i]}
          i=$((i + 1))
        fi
        check_value "$c" "$value" || exit 0
        break
      done
      ;;
    *)
      url_ok "$tok" || exit 0
      SAW_URL=1
      ;;
  esac
done

# --data-* without -G is a POST body, and this hook only ever speaks for GET/HEAD.
# `curl --data-urlencode 'query=up' http://127.0.0.1:9090/api/v1/query` writes; the
# same line with -G reads. Refusing the pair unless -G is present is what keeps
# "provably a plain GET" true after admitting the option.
((SAW_DATA == 1 && SAW_GET == 0)) && exit 0

((SAW_URL == 1)) && allow

# No URL, or nothing provably safe about it -> defer to normal permission handling.
exit 0
