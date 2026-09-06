#!/usr/bin/env bash
# allow-ansible-readonly.sh
#
# PermissionRequest hook for Bash. Auto-approves an ansible-playbook invocation that is
# provably read-only, so `--check`/`--list-tasks`/`--list-tags`/`--list-hosts`/
# `--syntax-check` stop prompting. Anything else produces no decision and falls through
# to the `Bash(ansible-playbook:*)` / `Bash(uv run ansible-playbook:*)` /
# `Bash(uv run --frozen ansible-playbook:*)` ask rules.
#
# Those ask rules exist because a hand-run playbook is a real deploy on the homelab
# server repo, bypassing that repo's scripts/deploy.sh and the lock it takes. They used
# to be reached only by accident, through that repo's uv-python.sh hook prepending an
# inline `python3 -c '...'` stdio fixup ahead of every ansible-playbook command — a
# prefix that happened to match `Bash(python3 -c:*)`, so the WHOLE compound command
# prompted regardless of what followed it. Replacing that inline fixup with the
# standalone stdio-blocking script removed the accidental guard, so this hook picks
# read-only invocations back out explicitly instead of relying on an ask rule that no
# longer fires on the prefix.
#
# The option table is an ALLOWLIST, same posture as allow-safe-rm.sh: a flag this
# script does not recognize decides nothing. Read-only-ness is not "no dangerous flag
# was seen" — it is "one of the five modes ansible itself treats as read-only was
# named", checked as a whole token, never as a substring of the command text. A
# `--check` sitting inside the STRING VALUE of `-e`/`--extra-vars` (an extra var whose
# value happens to contain that word) must not count, so this scans arguments as
# shell-quoted tokens and treats the token immediately after -e/--extra-vars as an
# opaque value, never as a candidate flag.
#
# `--check` only means "make no changes" when nothing it evaluates comes from outside
# the command line. `-e @file.yml` / `--extra-vars @file.yml` loads that file's content
# as vars, and this hook cannot see what is in it — a same-repo lookup plugin or a
# vars_prompt default could still have a side effect. So a file-valued (`@...`)
# extra-vars anywhere in the command refuses the whole thing, even alongside --check.
# `--check` combined with `--diff` is still read-only; --diff only prints, so it is not
# tested for here at all.
#
# Two invocation shapes this hook must also see through, because they are exactly what
# the homelab server repo's uv-python.sh hook now produces: an optional leading
# `stdio-blocking; ` (the fd-blocking prefix, replacing the old ask-listed
# `python3 -c` one), and an optional trailing `2>&1 | tail -n <N>` or `tail -<N>` (bounding output).
# Both are stripped by exact pattern before the command is tokenized, so neither
# smuggles in extra shell structure — the tokenizer below still refuses on any other
# `;`, `&&`, `|`, or redirection.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[[ -z $COMMAND ]] && exit 0

# Strip the one leading prefix and one trailing suffix this hook understands. Neither
# strip is optional-shell-safe on its own -- if the pattern isn't there verbatim, the
# string is left untouched and the tokenizer below will refuse on whatever remains.
CORE=$COMMAND
if [[ $CORE =~ ^stdio-blocking\;[[:space:]]*(.*)$ ]]; then
  CORE=${BASH_REMATCH[1]}
fi
if [[ $CORE =~ ^(.*[^[:space:]])[[:space:]]*2\>\&1[[:space:]]*\|[[:space:]]*tail[[:space:]]+-(n[[:space:]]*)?[0-9]+[[:space:]]*$ ]]; then
  CORE=${BASH_REMATCH[1]}
fi

# Read-only ansible modes. Anything else (or nothing from this table) is not a
# decision this hook can make.
READONLY=(--check --list-tasks --list-tags --list-hosts --syntax-check)

# Tokenizer: identical posture to allow-safe-rm.sh's -- any shell-special character
# outside quotes is a refusal, so chaining, piping, redirection, substitution and
# globs are read the same way the shell would read them, and none of that has to be
# reasoned about token-by-token below.
NTOK=0
TOKENS=()
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
              TOKENS[NTOK]=$cur; NTOK=$((NTOK + 1)); cur=''; started=''
            fi
            ;;
          "'") state=single; started=1 ;;
          '"') state=double; started=1 ;;
          ';' | '&' | '|' | '<' | '>' | '(' | ')' | '{' | '}' | '$' | '`' | \\ | \
            '*' | '?' | '[' | ']' | $'\n' | $'\r')
            return 1 ;;
          '~') return 1 ;;
          *) cur+=$c; started=1 ;;
        esac
        ;;
      single)
        if [[ $c == "'" ]]; then state=''; else cur+=$c; fi
        ;;
      double)
        case $c in
          '"') state='' ;;
          '$' | '`' | \\) return 1 ;;
          *) cur+=$c ;;
        esac
        ;;
    esac
  done
  [[ -n $state ]] && return 1          # unterminated quote
  if [[ -n $started ]]; then TOKENS[NTOK]=$cur; NTOK=$((NTOK + 1)); fi
  return 0
}

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
  exit 0
}

tokenize "$CORE" || exit 0
((NTOK > 0)) || exit 0

# Recognize exactly: ansible-playbook ..., uv run ansible-playbook ..., or
# uv run --frozen ansible-playbook .... Nothing else may precede ansible-playbook.
idx=0
if [[ ${TOKENS[0]##*/} == ansible-playbook ]]; then
  idx=1
elif [[ ${TOKENS[0]} == uv && $NTOK -gt 1 && ${TOKENS[1]} == run ]]; then
  if [[ $NTOK -gt 2 && ${TOKENS[2]##*/} == ansible-playbook ]]; then
    idx=3
  elif [[ $NTOK -gt 3 && ${TOKENS[2]} == --frozen && ${TOKENS[3]##*/} == ansible-playbook ]]; then
    idx=4
  else
    exit 0
  fi
else
  exit 0
fi

SAW_READONLY=0
i=$idx
while ((i < NTOK)); do
  tok=${TOKENS[i]}
  i=$((i + 1))

  # The value of -e/--extra-vars is opaque: never scanned for a read-only flag, only
  # ever checked for the one thing that disqualifies it (a file reference).
  if [[ $tok == -e || $tok == --extra-vars ]]; then
    val=${TOKENS[i]:-}
    i=$((i + 1))
    [[ $val == @* ]] && exit 0
    continue
  fi
  if [[ $tok == --extra-vars=* ]]; then
    [[ ${tok#--extra-vars=} == @* ]] && exit 0
    continue
  fi
  # Attached short form, e.g. -e@vars.yml or -eKEY=VAL, with no space or '='.
  if [[ $tok == -e?* && $tok != --* ]]; then
    [[ ${tok:2} == @* ]] && exit 0
    continue
  fi

  for r in "${READONLY[@]}"; do
    [[ $tok == "$r" ]] && { SAW_READONLY=1; break; }
  done
done

((SAW_READONLY == 1)) && allow

# No read-only mode named, or nothing provably safe -> defer to normal permission handling.
exit 0
