#!/usr/bin/env bash
# allow-compound-bash.sh
#
# PermissionRequest hook for Bash.
# Reads allow/deny/ask patterns directly from the settings files (user-level
# plus the current project's settings.json / settings.local.json) so there
# is one source of truth. For compound commands (&&, ;), if every sub-command
# matches the allow list and none match the deny or ask lists, grants permission
# automatically — no prompt needed for chaining individually-allowed commands.

set -u

# A project's own settings may only TIGHTEN what is auto-approved here. deny and ask are
# read from every file; allow comes from the user-level settings ALONE. Otherwise any repo
# could ship a .claude/settings.json granting itself whatever it liked, and merely opening
# that repo would turn those grants into unprompted approvals. Measured before the split: a
# repo allowing `Bash(frobnicate:*)` took `echo hi && frobnicate --wipe /` from a prompt to
# an unprompted allow. Same asymmetry as the glob routing below — narrowing is a security
# fix, widening is the owner's call, and the owner's file is the user-level one.
USER_SETTINGS=("$HOME/.claude/settings.json")
SETTINGS_FILES=("${USER_SETTINGS[@]}")
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  for f in "$CLAUDE_PROJECT_DIR/.claude/settings.json" "$CLAUDE_PROJECT_DIR/.claude/settings.local.json"; do
    [ -f "$f" ] && SETTINGS_FILES+=("$f")
  done
fi
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# M02 shadow census. CMDPARSE_SHADOW=1 computes what the shared decomposition in
# cmdparse.sh WOULD decide, logs old-vs-new, and returns the OLD decision unchanged. It is
# the instrument for the cutover: the hooks run on every Bash call, so the log is a census of
# live traffic rather than a synthetic sample, and the ship gate for the next slice is that
# no logged command moves toward `allow`.
#
# Absent library => shadow silently off. It cannot fail open, because the only thing the
# shadow can do to a decision is withhold an approval (see SHADOW_ONLY below).
CP_SHADOW=0
if [ "${CMDPARSE_SHADOW:-0}" = 1 ] && [ "${CMDPARSE:-on}" != off ]; then
  # shellcheck source=/dev/null
  if . "${CMDPARSE_LIB:-${BASH_SOURCE[0]%/*}/cmdparse.sh}" 2>/dev/null; then CP_SHADOW=1; fi
fi

# Only act on compound commands (chains or pipes).
#
# A newline-separated command is not compound to this test, so it exits here and falls
# through to native prefix matching (A1-16). SHADOW_ONLY exists to measure exactly that
# population: when the shared parser says the command really is several commands, carry on
# through the judgement below so the census can record what would have happened — but pin
# the decision to defer, which is what exiting here already meant. The shadow can therefore
# only ever withhold an approval, never add one.
SHADOW_ONLY=0
if [[ "$COMMAND" != *"&&"* && "$COMMAND" != *";"* && "$COMMAND" != *"|"* ]]; then
  if [ "$CP_SHADOW" = 1 ] && cmd_parse "$COMMAND" && [ "$CP_NSEG" -gt 1 ]; then
    SHADOW_ONLY=1
  else
    exit 0
  fi
fi

# Extract Bash(...) entries from a permissions list and normalize to plain
# command prefixes by stripping Bash(...) wrapper and trailing :*, *, etc.
extract_bash_prefixes() {
  local field="$1" s
  shift
  for s in "$@"; do
    jq -r --arg f "$field" \
      '.permissions[$f][]? | select(startswith("Bash(")) | ltrimstr("Bash(") | rtrimstr(")") | gsub(":\\*$";"") | gsub(" \\*$";"") | gsub("\\*$";"")' \
      "$s" 2>/dev/null
  done
}

ALLOW=()
while IFS= read -r line; do [[ -n "$line" ]] && ALLOW+=("$line"); done < <(extract_bash_prefixes "allow" ${USER_SETTINGS[@]+"${USER_SETTINGS[@]}"})

# Deny/ask rules split into two classes. The gsub chain above only strips a TRAILING
# wildcard, so any `*` still present is an interior or leading one — `git commit
# *--no-verify`, `* | sh`, the eight `gh api *-X <VERB>` rules — and matches_any
# compares with the pattern QUOTED, making every one of them a dead literal string.
# Each then fell through to an allow prefix (`git commit`, `gh api`) and auto-approved.
# Route those to matches_glob instead.
#
# Deny/ask only, deliberately: the same treatment on the allow list would activate its
# dead wildcards too and WIDEN auto-approval. Narrowing is a security fix; widening is
# the owner's call.
DENY=(); DENY_GLOB=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  case $line in *'*'*) DENY_GLOB+=("$line") ;; *) DENY+=("$line") ;; esac
done < <(extract_bash_prefixes "deny" ${SETTINGS_FILES[@]+"${SETTINGS_FILES[@]}"})
ASK=(); ASK_GLOB=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  case $line in *'*'*) ASK_GLOB+=("$line") ;; *) ASK+=("$line") ;; esac
done < <(extract_bash_prefixes "ask" ${SETTINGS_FILES[@]+"${SETTINGS_FILES[@]}"})

trim() {
  local s="$1"
  s="${s#"${s%%[! $'\t']*}"}"
  s="${s%"${s##*[! $'\t']}"}"
  printf '%s' "$s"
}

matches_any() {
  local cmd="$1"; shift
  local patterns=("$@")
  for p in ${patterns[@]+"${patterns[@]}"}; do
    # Exact match, or prefix followed by a space (prevents "git" matching "git-lfs")
    [[ "$cmd" == "$p" || "$cmd" == "$p "* || "$cmd" == "$p"/* ]] && return 0
  done
  return 1
}

# Same job as matches_any for patterns carrying an interior `*`, but the RHS is left
# UNQUOTED so bash treats it as a pattern. The trailing-`*` variant covers the rules
# whose wildcard sits before the flag they are guarding — `git commit *--no-verify`
# has to catch `git commit -m x --no-verify -S` too, not just a command ending there.
matches_glob() {
  local cmd="$1"; shift
  local p
  for p in ${1+"$@"}; do
    # shellcheck disable=SC2053  # unquoted RHS is the point: glob, not literal compare
    [[ "$cmd" == $p || "$cmd" == $p* ]] && return 0
  done
  return 1
}

# Wrapper commands take another command as an ARGUMENT and exec it. matches_any only ever
# inspects a segment's leading words, so it judged the wrapper and never looked at what was
# about to run: `xargs python -c '...'` rode in on the allow entry for xargs, unprompted.
# Same family as the `env` and `find -exec` holes, one level further out.
#
# Resolve a segment to the command that will actually execute. Prints it and returns 0;
# returns non-zero when the argument shape is not one we can read with confidence. A
# wrapper we cannot read MUST prompt — never fall back to the wrapper's own allow entry,
# which is exactly the mistake that made `xargs` a bypass. A segment that is not a wrapper
# at all comes back unchanged, so callers can pipe everything through this.
#
# The flag tables below are deliberately closed: an option this does not recognise is a
# refusal, not a skip. Guessing an option's arity is how you walk past the command word.
unwrap_wrapper() {
  local s="$1" depth=0 w n i tok
  local -a t
  while [ "$depth" -lt 4 ]; do   # `timeout 5 nohup nice cmd` nests; a bound stops a cycle
    depth=$((depth + 1))
    read -r -a t <<< "$s"
    n=${#t[@]}
    [ "$n" -eq 0 ] && return 1
    w=${t[0]##*/}
    case $w in
      timeout|env|nice|nohup|setsid|stdbuf|xargs) ;;
      *) printf '%s' "$s"; return 0 ;;
    esac
    i=1
    case $w in
      nohup|setsid) ;;
      nice)
        while [ "$i" -lt "$n" ]; do
          case ${t[i]} in
            -n) i=$((i + 2)); continue ;;
            -[0-9]*|--adjustment=*) i=$((i + 1)); continue ;;
            --) i=$((i + 1)); break ;;
            -*) return 1 ;;
          esac
          break
        done ;;
      timeout)
        while [ "$i" -lt "$n" ]; do
          case ${t[i]} in
            --preserve-status|--foreground|-v|--verbose) i=$((i + 1)); continue ;;
            -s|-k) i=$((i + 2)); continue ;;
            --signal=*|--kill-after=*) i=$((i + 1)); continue ;;
            --) i=$((i + 1)); break ;;
            -*) return 1 ;;
          esac
          break
        done
        # The duration is positional and mandatory; without consuming it the command word
        # would come back as the number.
        [ "$i" -lt "$n" ] || return 1
        case ${t[i]} in
          [0-9]*) i=$((i + 1)) ;;
          *) return 1 ;;
        esac ;;
      env)
        # Only the plain `env VAR=VALUE... cmd` shape. Every option is refused on purpose:
        # -S splits a string into fresh arguments, -i and -u reshape the environment the
        # inner command runs in. Neither is readable from the command word alone.
        while [ "$i" -lt "$n" ]; do
          case ${t[i]} in
            -*) return 1 ;;
            *=*) i=$((i + 1)); continue ;;
          esac
          break
        done ;;
      stdbuf)
        while [ "$i" -lt "$n" ]; do
          case ${t[i]} in
            -[ioe]?*|--input=*|--output=*|--error=*) i=$((i + 1)); continue ;;
            --) i=$((i + 1)); break ;;
            -*) return 1 ;;   # includes the separated `-o L` form
          esac
          break
        done ;;
      xargs)
        while [ "$i" -lt "$n" ]; do
          case ${t[i]} in
            -0|-r|-t|-x|-p|--null|--no-run-if-empty|--verbose|--interactive) i=$((i + 1)); continue ;;
            -n|-I|-P|-d|-a|-L|-s|-E) i=$((i + 2)); continue ;;
            -n*|-I*|-P*|-d*|-a*|-L*|-s*|-E*) i=$((i + 1)); continue ;;
            --max-args=*|--replace=*|--max-procs=*|--delimiter=*) i=$((i + 1)); continue ;;
            --arg-file=*|--max-lines=*|--max-chars=*|--eof=*) i=$((i + 1)); continue ;;
            --) i=$((i + 1)); break ;;
            -*) return 1 ;;   # -e and -l carry OPTIONAL arguments; arity is unknowable
          esac
          break
        done
        # Bare `xargs` runs echo. Harmless, but there is no command word to judge.
        [ "$i" -lt "$n" ] || return 1 ;;
    esac
    [ "$i" -lt "$n" ] || return 1
    # Word splitting above is naive, so a quote among the tokens just consumed means the
    # real argument boundaries are not where they appear. Refuse rather than guess.
    for tok in "${t[@]:0:$i}"; do
      case $tok in *\'*|*\"*) return 1 ;; esac
    done
    s="${t[*]:$i}"
  done
  return 1
}

# Command substitution / process substitution can smuggle a gated or unlisted
# command inside an otherwise-allowed segment; the split below won't see it
# (e.g. `echo $(curl …) && ls` would auto-approve the curl). Defer to normal handling.
if printf '%s' "$COMMAND" | grep -qE '\$\(|`|<\(|>\('; then
  exit 0
fi

# Split on &&, ||, ; and | that fall OUTSIDE quotes.
#
# This used to bail whenever a delimiter appeared anywhere inside quotes, so that a
# naive splitter never mangled `echo "a && b" && ls`. The regex it used could not tell
# a delimiter *inside* one quoted string from one *between* two separately quoted
# arguments, so it also fired on `jq '.a' f.json; jq '.b' f.json` and on every jq filter
# containing a pipe — i.e. on most real JSON work, which then prompted every time.
# Tracking quote state costs a character loop and lets those through, while a quoted
# delimiter stays inert because it never ends a segment.
#
# Bash 3.2 clean (macOS default bash): no mapfile, no associative arrays.
split_outside_quotes() {
  local s="$1"
  local n=${#s}   # separate `local`: ${#s} would read the *outer* s in a combined one
  local i=0 q='' cur='' c next prev
  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    if [ -n "$q" ]; then
      # Inside quotes. Only "..." honours a backslash escape; '...' is literal.
      if [ "$q" = '"' ] && [ "$c" = $'\\' ]; then
        cur="$cur$c${s:i+1:1}"; i=$((i + 2)); continue
      fi
      [ "$c" = "$q" ] && q=''
      cur="$cur$c"; i=$((i + 1)); continue
    fi
    case $c in
      \'|\") q=$c; cur="$cur$c"; i=$((i + 1)); continue ;;
      \\)    cur="$cur$c${s:i+1:1}"; i=$((i + 2)); continue ;;
    esac
    next=${s:i+1:1}
    if { [ "$c" = '&' ] && [ "$next" = '&' ]; } || { [ "$c" = '|' ] && [ "$next" = '|' ]; }; then
      printf '%s\n' "$cur"; cur=''; i=$((i + 2)); continue
    fi
    # A lone `&` backgrounds the command to its left and starts a new one, so it is a
    # separator too. Falling through to the append below glued everything after it onto
    # the previous segment, and matches_any only ever inspects a segment's prefix — so
    # `git status && ls & <anything>` inherited `ls`'s approval and auto-allowed.
    # `>&`/`<&` are fd dups rather than separators; leave those to the redirection check.
    if [ "$c" = '&' ]; then
      prev=''
      [ -n "$cur" ] && prev=${cur:$((${#cur} - 1)):1}
      if [ "$prev" != '>' ] && [ "$prev" != '<' ]; then
        return 1
      fi
    fi
    if [ "$c" = ';' ] || [ "$c" = '|' ]; then
      printf '%s\n' "$cur"; cur=''; i=$((i + 1)); continue
    fi
    cur="$cur$c"; i=$((i + 1))
  done
  # Unbalanced quote — we cannot reason about the shape, so refuse to split it.
  [ -n "$q" ] && return 1
  printf '%s\n' "$cur"
  return 0
}

# Glob deny/ask patterns are tested against the WHOLE command before it is split, as
# well as against each segment below. The splitter consumes `|`, so a rule written
# across a pipe — `* | sh`, `* | bash` — is only ever intact at this point.
# Recorded rather than exited on, so the shadow census below can log this outcome too. It
# is a whole-command test, so it applies identically to the old and the new segmentation.
WHOLE_GLOB_DEFER=0
if matches_glob "$COMMAND" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"} \
  || matches_glob "$COMMAND" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
  WHOLE_GLOB_DEFER=1
fi

# The per-segment judgement, lifted verbatim out of the loop it used to be written inline
# as. It reads JSEG/JSEG_N so the same code can be run over the old splitter's segments and
# over cmdparse.sh's, which is the whole point: the census compares two SEGMENTATIONS, not
# two policies. Returns 0 to allow, 1 to defer.
judge() {
  local idx=0 part redir teed teecmd target
  while [ "$idx" -lt "$JSEG_N" ]; do
    part=$(trim "${JSEG[idx]}")
    idx=$((idx + 1))
    [ -z "$part" ] && continue

  # Redirection turns an allow-listed reader into a writer (`jq . f.json > ~/.bashrc`),
  # and matches_any only ever looks at the command prefix. Quote-aware splitting brought
  # segments like that within reach for the first time, so bail rather than guess.
  # /dev/null and fd dups are the harmless cases and are everywhere in diagnostics.
  redir=$(printf '%s' "$part" | sed -E 's@[0-9]*>>?[[:space:]]*/dev/null@@g; s@[0-9]*>&[0-9-]@@g')
  case $redir in
    *'>'*) return 1 ;;
  esac

  # `tee` is the same hazard without a `>`: it writes every path it is handed, so
  # `echo hi | tee ~/.bashrc` cleared the check above and rode in on two allow-listed
  # commands. Bail on a tee segment that names a target; bare `tee` and `tee /dev/null`
  # only copy to stdout and stay allowed. Options are dropped first so `tee -a f` is
  # judged on `f`, not on the flag.
  # Match on the command WORD, not a glob over the whole segment: `*/tee` also matches a
  # segment whose last ARGUMENT ends in /tee, which let `tee /usr/bin/tee` look harmless.
  teed=$(printf '%s' "$part" | sed -E 's@[[:space:]]+-[^[:space:]]+@@g; s@[[:space:]]+/dev/null@@g')
  teecmd=${teed%%[[:space:]]*}
  case ${teecmd##*/} in
    tee) [ "$teed" != "$teecmd" ] && return 1 ;;
  esac

  # Deny or ask list → defer to normal permission handling
  if matches_any "$part" ${DENY[@]+"${DENY[@]}"} || matches_any "$part" ${ASK[@]+"${ASK[@]}"} \
    || matches_glob "$part" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"} \
    || matches_glob "$part" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
    return 1
  fi

  # A rule may name a wrapper invocation exactly — `/usr/bin/env bash --version` is
  # allow-listed as that whole string — so honour the allow list as written before
  # unwrapping, or that narrowed rule becomes unreachable. A broad `wrapper:*` prefix
  # cannot sneak back in this way: the content guard in tests/allow-compound-bash.test.js
  # refuses any allow rule whose last word is a command-taking spawner.
  if matches_any "$part" "${ALLOW[@]}"; then
    continue
  fi

  # Otherwise judge what the segment will actually RUN, not the wrapper in front of it.
  # Unreadable wrapper → defer; that failure mode is the whole point of the function.
  target=$(unwrap_wrapper "$part") || return 1
  # Not a wrapper, and it already failed the allow list above.
  [ "$target" = "$part" ] && return 1

  # The unwrapped command earns the same deny/ask scrutiny the segment just got. Skipping
  # this would let a wrapper carry a denied command past its own rule: the deny prefixes
  # are anchored at the start of a segment, so `curl` never matches `xargs curl …`.
  if matches_any "$target" ${DENY[@]+"${DENY[@]}"} || matches_any "$target" ${ASK[@]+"${ASK[@]}"} \
    || matches_glob "$target" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"} \
    || matches_glob "$target" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
    return 1
  fi

  # Not in allow list → defer
  if ! matches_any "$target" "${ALLOW[@]}"; then
    return 1
  fi
  done
  return 0
}

# --- decision ------------------------------------------------------------------------------
#
# OLD is what this hook has always decided: today's splitter, today's judgement. NEW is the
# same judgement over cmdparse.sh's segmentation. Only OLD is ever emitted in this slice.

OLD=defer
if [ "$SHADOW_ONLY" = 0 ] && [ "$WHOLE_GLOB_DEFER" = 0 ]; then
  if SPLIT=$(split_outside_quotes "$COMMAND"); then
    JSEG=(); JSEG_N=0
    while IFS= read -r line; do
      [ -n "$line" ] && { JSEG[JSEG_N]=$line; JSEG_N=$((JSEG_N + 1)); }
    done <<< "$SPLIT"
    judge && OLD=allow
  fi
fi

if [ "$CP_SHADOW" = 1 ]; then
  NEW=defer
  # An unreadable command is a refusal, never a skip — so it stays `defer` here.
  if [ "$WHOLE_GLOB_DEFER" = 0 ] && cmd_parse "$COMMAND"; then
    JSEG=(); JSEG_N=0
    _i=0
    while [ "$_i" -lt "$CP_NSEG" ]; do
      JSEG[JSEG_N]=${CP_SEG[_i]}; JSEG_N=$((JSEG_N + 1)); _i=$((_i + 1))
    done
    judge && NEW=allow
  fi
  # One line per live Bash call. The ship gate for the cutover slice reads this file and
  # requires zero `old != allow -> new == allow` transitions; anything else is a parser bug,
  # not acceptable friction.
  LOGDIR="${CLAUDE_SHADOW_LOG_DIR:-$HOME/.claude/logs}"
  mkdir -p "$LOGDIR" 2>/dev/null && jq -cn \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg hook allow-compound-bash \
    --arg cmd "$COMMAND" \
    --arg old "$OLD" \
    --arg new "$NEW" \
    --arg status "$CP_STATUS" \
    --argjson nseg "$CP_NSEG" \
    --argjson shadow_only "$SHADOW_ONLY" \
    '{ts:$ts,hook:$hook,cmd:$cmd,old:$old,new:$new,status:$status,nseg:$nseg,shadow_only:$shadow_only}' \
    >> "$LOGDIR/cmdparse-shadow.jsonl" 2>/dev/null
fi

# The old decision, unchanged. SHADOW_ONLY commands never reach `allow` because OLD is
# pinned to defer above, which is exactly what exiting at the compound gate already meant.
[ "$OLD" = allow ] && \
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
exit 0
