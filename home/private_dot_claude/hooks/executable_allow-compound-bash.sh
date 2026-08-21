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
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')

# --- segmentation: shared cmd_parse library ---------------------------------------------
#
# Segmentation used to be hand-rolled here (split_outside_quotes, since removed). cmd_parse
# is now the single source of truth for where one command ends and the next begins -- see
# its CONTRACT comment. This hook's own splitter didn't treat a newline as a separator and
# re-split heredoc bodies on \n, prompting on every ordinary `gh pr create --body-file -
# <<EOF`. A shadow census run against ~11,900 real Bash calls (M02, since retired now that
# this is the real decision) found the swap decision-neutral once the two guards below are
# in place; see the PR body for the count.
#
# CMDPARSE=off is the rollback lever: with it set, or if the library cannot be sourced,
# this hook always defers. It has no segmentation of its own to fall back to now, and a
# hook that cannot judge every sub-command must not approve any of them.
if [ "${CMDPARSE:-on}" = off ]; then
  exit 0
fi
# shellcheck source=/dev/null
. "${CMDPARSE_LIB:-${BASH_SOURCE[0]%/*}/cmdparse.sh}" 2>/dev/null || exit 0

# Only act on compound commands (chains or pipes). Literal substring test, deliberately --
# the auto-approval population is unchanged from before this migration. A newline-only or
# lone-`&`-only command was never eligible for allow (DECIDED, see the "newline-only
# compounds" test in cmdparse-shadow.test.js), and widening eligibility to that population
# is a policy call for a later slice, not a side effect of swapping the segmenter. What
# moves here is the JUDGMENT within the already-eligible population, not who is eligible.
if [[ "$COMMAND" != *"&&"* && "$COMMAND" != *";"* && "$COMMAND" != *"|"* ]]; then
  exit 0
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

# A `curl` segment always matches the `Bash(curl:*)` ask rule, so a pipeline as ordinary
# as `curl -s URL | jq .` could never be approved here no matter how safe both halves
# were. That is not a corner case: 118 of the 147 curl prompts in the week of 2026-08-07
# were exactly this shape, and it is how you read anything out of Prometheus or Loki.
#
# allow-safe-curl.sh already answers "is this curl a provable GET/HEAD against an
# allowlisted host" for a bare invocation. Ask it the same question about the segment
# rather than restating its option table here -- the alternative is a second parser that
# drifts from the first. Delegation only ever ADDS an allow for a segment that hook would
# have approved standing alone; deny is checked before this point and still wins, and
# every OTHER stage of the pipeline still has to earn its own allow entry, so
# `curl URL | sh` stays a prompt because `sh` is on nobody's allow list.
#
# Silent, missing, or non-executable helper -> return 1 and the segment falls through to
# the ask check unchanged. Same failure posture as the rest of this file.
# Deployed as `allow-safe-curl.sh`; in the chezmoi source tree the same file carries the
# `executable_` attribute prefix. Resolve either so the suite exercises this path against
# the source checkout rather than silently testing nothing.
SAFE_CURL="${BASH_SOURCE[0]%/*}/allow-safe-curl.sh"
[ -f "$SAFE_CURL" ] || SAFE_CURL="${BASH_SOURCE[0]%/*}/executable_allow-safe-curl.sh"
safe_curl_ok() {
  [ -f "$SAFE_CURL" ] || return 1
  jq -nc --arg c "$1" '{tool_input: {command: $c}}' 2>/dev/null \
    | HOOK_INPUT_LIB="${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}" \
      bash "$SAFE_CURL" 2>/dev/null | grep -q '"allow"'
}

# Same delegation, same reasoning, for the other ask-listed command that takes an
# arbitrary target. A scratch cleanup is the commonest ask-listed segment in a chain:
# 51 of the 611 prompts on daniel-box in the week to 2026-08-21, and each one prompted
# for the whole chain because that segment could never clear the ask list on its own.
SAFE_RM="${BASH_SOURCE[0]%/*}/allow-safe-rm.sh"
[ -f "$SAFE_RM" ] || SAFE_RM="${BASH_SOURCE[0]%/*}/executable_allow-safe-rm.sh"
safe_rm_ok() {
  [ -f "$SAFE_RM" ] || return 1
  jq -nc --arg c "$1" '{tool_input: {command: $c}}' 2>/dev/null \
    | HOOK_INPUT_LIB="${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}" \
      bash "$SAFE_RM" 2>/dev/null | grep -q '"allow"'
}

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
# as. Reads JSEG/JSEG_N, populated below from cmd_parse's CP_SEG. Returns 0 to allow, 1 to
# defer.
judge() {
  local idx=0 part redir teed teecmd target ffref
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

  # Deny list → defer. No exception below reaches past this.
  if matches_any "$part" ${DENY[@]+"${DENY[@]}"} \
    || matches_glob "$part" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"}; then
    return 1
  fi

  # The one ask-listed segment named as safe here, and the only place it can be named:
  # `Bash(git merge:*)` is ask-listed, ask is evaluated before allow, and specificity does
  # not break the tie, so no permission rule can free `--ff-only` on its own. Every real
  # invocation is a compound (`git merge --ff-only origin/main 2>&1 | tail -3`), which is
  # why it lands here rather than in a rule at all.
  #
  # `--ff-only` refuses anything that is not a fast-forward: it cannot create a merge
  # commit, cannot leave a conflicted index, and fails with a message instead. Exactly one
  # ref may follow, and it may not look like an option — otherwise `git merge --ff-only
  # --no-ff x` would ride in on the prefix. Bare `git merge`, `--no-ff`, `--squash`,
  # `--strategy` and `-X` all miss this and stay gated by the ask rule below.
  # The ref is read off $redir, not $part: nearly every real call carries `2>&1`, and
  # judging the raw segment would see two words and refuse the whole exception.
  case $part in
    'git merge --ff-only '*)
      ffref=$(trim "${redir#git merge --ff-only }")
      case $ffref in
        ''|-*|*[[:space:]]*) ;;
        *) continue ;;
      esac ;;
  esac

  # A provably-safe curl resolves its own ask rule — see safe_curl_ok above. Placed
  # after the deny check and before the ask check, which is exactly where this hook
  # sits relative to allow-safe-curl.sh at the top level.
  case ${part%%[[:space:]]*} in
    curl | */curl)
      if safe_curl_ok "$part"; then
        continue
      fi
      ;;
    rm | */rm)
      if safe_rm_ok "$part"; then
        continue
      fi
      ;;
  esac

  # Ask list → defer to normal permission handling
  if matches_any "$part" ${ASK[@]+"${ASK[@]}"} \
    || matches_glob "$part" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
    return 1
  fi

  # A rule may name a wrapper invocation exactly — `/usr/bin/env bash --version` is
  # allow-listed as that whole string — so honour the allow list as written before
  # unwrapping, or that narrowed rule becomes unreachable. A broad `wrapper:*` prefix
  # cannot sneak back in this way: the content guard in tests/hooks/allow-compound-bash.test.js
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
# cmd_parse's own refusal (unbalanced quote or substitution, CP_STATUS != ok) gets the same
# response split_outside_quotes's failure return used to: defer. A non-zero return is a
# REFUSAL per the library's contract, never a skip.
DECISION=defer
if [ "$WHOLE_GLOB_DEFER" = 0 ] && cmd_parse "$COMMAND"; then
  # Two things stay conservative on purpose, matching what the removed splitter already
  # refused on -- this migration moves the SEGMENTATION, not the policy:
  #
  # - A bare `&` or a newline separator: split_outside_quotes returned failure outright on
  #   a lone `&` (backgrounding glued the next command onto the previous one's approval),
  #   and a newline was never a separator to it at all, so a command that only becomes
  #   multi-segment via one of these never reached judge() before. Preserve that.
  # - Any substitution (CP_NSUBSEG -gt 0): a substitution's content is an opaque atom in
  #   CP_SEG (per the library's contract) -- judge() has no way to vet what runs inside
  #   it, so it must not silently pass on the strength of the segment that CONTAINS it.
  #   A heredoc body is the same blind spot for a different reason: cmd_parse lifts it out
  #   whole and never scans it for a substitution, so an unquoted heredoc delimiter could
  #   carry a live `$(...)` this hook cannot see. Treat carrying either as unjudgeable.
  UNJUDGEABLE=0
  [ "$CP_NSUBSEG" -gt 0 ] && UNJUDGEABLE=1
  _i=0
  while [ "$_i" -lt "$CP_NSEG" ]; do
    [ -n "${CP_HEREDOC[_i]}" ] && UNJUDGEABLE=1
    if [ "$_i" -lt "$((CP_NSEG - 1))" ]; then
      case ${CP_SEP[_i]} in
        '&' | newline) UNJUDGEABLE=1 ;;
      esac
    fi
    _i=$((_i + 1))
  done

  if [ "$UNJUDGEABLE" = 0 ]; then
    JSEG=(); JSEG_N=0
    _i=0
    while [ "$_i" -lt "$CP_NSEG" ]; do
      JSEG[JSEG_N]=${CP_SEG[_i]}; JSEG_N=$((JSEG_N + 1)); _i=$((_i + 1))
    done
    judge && DECISION=allow
  fi
fi

[ "$DECISION" = allow ] && \
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
exit 0
