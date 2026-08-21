#!/usr/bin/env bash
# allow-safe-rm.sh
#
# PermissionRequest hook for Bash. Auto-approves a remove whose every operand is
# provably confined to a scratch root, so clearing a temp directory stops prompting.
# Anything else produces no decision and falls through to the `Bash(rm:*)` ask rule.
#
# The command sits in the ask list because it takes arbitrary paths and the loss is not
# recoverable. A permission prefix rule cannot narrow that: a rule naming a directory
# prefix constrains nothing after it, so an operand that starts inside the scratch root
# and then walks out with `..` matches the rule anyway. The two things this hook has to
# establish are that every operand lands under a scratch root and that no option or
# path form can undo that.
#
# Volume is why it earns the exception: 51 of the 611 permission prompts on daniel-box
# in the week to 2026-08-21 came from this command, and 20 of the 99 on this PC — the
# top program in both. The compound hook refuses any chain containing an ask-listed
# segment, so a single scratch cleanup in a test harness prompted for the whole chain.
#
# The option table is an ALLOWLIST, same posture as allow-safe-curl.sh: an option this
# script does not name is not a decision. Absent by intent is --no-preserve-root, the
# only guard standing between a recursive delete and the filesystem root, along with
# anything that would read targets from somewhere this script cannot see. There is no
# such option today; naming the posture keeps a future one out by default.
#
# What this hook can NOT see, and why it is still sound: a symlink under a scratch root
# pointing outside it. Deleting the link deletes the link itself, and POSIX never
# traverses a symlink while deleting, so the target is untouched. A trailing slash on a
# symlink operand makes the command refuse rather than follow.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[[ -z $COMMAND ]] && exit 0

# Scratch roots. An operand must sit strictly BELOW one of these — the root itself is
# refused, so clearing the whole of /tmp never rides in on the entry that frees a
# directory inside it. Deliberately no env var or config file: either would be a way to
# widen this from outside the file. $TMPDIR is read but only honoured when it is itself
# under /tmp, so exporting it as a home path cannot move the boundary.
SCRATCH_ROOTS=(
  /tmp
  /var/tmp
  "$HOME/.claude/jobs"
  "$HOME/.cache/claude"
)
if [[ -n ${TMPDIR:-} && $TMPDIR == /tmp/* ]]; then
  SCRATCH_ROOTS+=("${TMPDIR%/}")
fi

# Options accepted that cannot move the operation off the operands checked below.
# -i/-I only add prompts; -v only prints. --preserve-root is the default and is named
# so writing it explicitly is not a refusal.
BOOL_SHORT='rRfdvIi'
LONG_OK=(
  --recursive --force --dir --verbose --interactive
  --one-file-system --preserve-root
)

# Split COMMAND into TOKENS. Any shell-special character OUTSIDE quotes is a refusal,
# which is what makes this script's reading of the command the same as the shell's: it
# covers chaining, pipes, redirection, substitution ($ and backtick, inside double
# quotes too), grouping, a leading ~, and the glob characters. Globs matter most here —
# the shell expands them AFTER the decision is made, so a pattern could arrive as paths
# this script never validated. Inside single quotes all of these are literal.
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

# True when $1 is strictly below one of SCRATCH_ROOTS. The path is checked lexically
# and any `..` is a refusal rather than something to resolve — resolving would need the
# path to exist, and the command is routinely pointed at one that does not.
under_scratch() {
  local p=$1 root
  [[ $p == /* ]] || return 1           # relative path: cwd is unknown here
  case $p in
    *..*) return 1 ;;                  # no traversal, quoted or not
  esac
  p=${p%/}                             # one trailing slash is cosmetic
  [[ -z $p ]] && return 1              # the filesystem root on its own
  case $p in
    *//*) return 1 ;;                  # collapsed separators: refuse rather than guess
  esac
  for root in "${SCRATCH_ROOTS[@]}"; do
    [[ $p == "$root"/?* ]] && return 0
  done
  return 1
}

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
  exit 0
}

tokenize "$COMMAND" || exit 0
((NTOK > 0)) || exit 0

# The command word, with any path prefix stripped. Nothing else may precede it: a
# leading `VAR=x` or a wrapper is somebody else's judgement to make.
[[ ${TOKENS[0]##*/} == rm ]] || exit 0

SAW_PATH=0
ENDOPTS=0
i=1
while ((i < NTOK)); do
  tok=${TOKENS[i]}
  i=$((i + 1))
  if ((ENDOPTS == 0)); then
    case $tok in
      --) ENDOPTS=1; continue ;;
      --*)
        ok=0
        for l in "${LONG_OK[@]}"; do [[ $tok == "$l" ]] && { ok=1; break; }; done
        ((ok == 1)) || exit 0
        continue ;;
      -?*)
        # Every letter in a cluster must be in the boolean table; there is no
        # value-taking short option, so a cluster is all-or-nothing.
        j=1
        while ((j < ${#tok})); do
          [[ $BOOL_SHORT == *"${tok:j:1}"* ]] || exit 0
          j=$((j + 1))
        done
        continue ;;
      -) exit 0 ;;
    esac
  fi
  under_scratch "$tok" || exit 0
  SAW_PATH=1
done

((SAW_PATH == 1)) && allow

# No operand, or nothing provably confined -> defer to normal permission handling.
exit 0
