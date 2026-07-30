#!/usr/bin/env bash
# shellcheck shell=bash
# cmdparse.sh — one decomposition of a Bash command, shared by every guard that judges one.
#
# Three hooks decide on each Bash tool call: block-dangerous-bash.sh (PreToolUse),
# allow-compound-bash.sh and allow-readonly-remote.sh (PermissionRequest). Each carries its
# own idea of where one command ends and the next begins, and the differences are where the
# bypasses live. Two verified this session, both from the same root cause — a newline is not
# a separator to any of them:
#
#   printf 'echo x\nterraform destroy'   -> no decision   (`echo x; terraform destroy` denies)
#   printf 'echo x\nssh homelab reboot'  -> no decision   (`echo x && ssh …` denies)
#
# block-dangerous-bash.sh:31 flattens `\n` to a SPACE before matching, so a rule anchored at
# a command position can never see the second command. allow-compound-bash.sh doesn't treat
# a newline as a separator either, and additionally re-splits its segments on `\n` when it
# transports them as text — so a heredoc body line becomes its own "segment" and ordinary
# `gh pr create --body-file - <<EOF` prompts every time.
#
# This library is the single segmentation. It is deliberately a sourced bash library rather
# than a python/node helper: the three hooks are on the hot path of every Bash call, and an
# interpreter start on each is a cost the current fork-heavy code is already paying too much
# of. A missing interpreter would also be a new fail-open surface, and this repo has been
# bitten by exactly that twice (the jq-missing fallbacks in block-dangerous-bash.sh and
# protect-secrets.sh were both written after a verified silent-off). Bash is the one
# dependency a hook cannot lose.
#
# Bash 3.2 clean (macOS default bash): no mapfile, no associative arrays, no `${arr[@]}` on a
# possibly-empty array under `set -u` — counters are tracked explicitly instead.
#
# CONTRACT, and the whole reason this is safe to adopt one call site at a time:
#   cmd_parse "$COMMAND"  -> 0 and CP_STATUS=ok
#                         -> non-zero and CP_STATUS=unreadable:<reason>
#   A NON-ZERO RETURN IS A REFUSAL, NEVER A SKIP. The caller must defer (PermissionRequest)
#   or ask (PreToolUse). It must never be read as "nothing to worry about here".
#
# Populated on success:
#   CP_STATUS        ok | unreadable:unbalanced-quote | unreadable:substitution
#   CP_NSEG          number of segments
#   CP_SEG[i]        raw segment text, quotes intact, as the shell would see it
#   CP_SEP[i]        separator that TERMINATED segment i: && || ; | & newline eof
#   CP_HEREDOC[i]    heredoc bodies attached to segment i, \x1f-joined ('' if none)
#
# A trailing separator leaves a final empty segment (`ls;` -> 2 segments). That is honest
# rather than tidy; consumers already skip empty segments.
#
# This slice deliberately stops at segmentation. Wrapper stripping, argv, canonical flags and
# write-target intent are later slices of the same module, and each one changes what the
# guards decide — segmentation alone does not.

# \x1f (unit separator) joins multi-valued fields: it cannot appear in a command line that
# came through JSON as a tool input, so it needs no escaping.
CP_US=$'\037'

CP_STATUS=''
CP_NSEG=0
CP_SEG=()
CP_SEP=()
CP_HEREDOC=()

# --- heredoc lift -----------------------------------------------------------------------
#
# Bodies are removed BEFORE segmentation, so their newlines are never separators and their
# contents are never commands. This cuts both ways and both directions matter: a body line
# reading `rm -rf /` must not be judged as a command, and a body must not be able to hide a
# real command from a rule either — which is why the operator itself stays in the segment
# text and the body is recorded against the segment that owns it.
_cp_lift() {
  local s="$1"
  local n=${#s}   # separate `local`: ${#s} would read the *outer* s in a combined one
  local i=0 q='' c
  local pend_n=0 pend_delim='' pend_strip='' k
  local line ldelim body off

  _cp_stripped=''
  _cp_hd_n=0
  _cp_hd_off=()
  _cp_hd_body=()

  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    if [ -n "$q" ]; then
      if [ "$q" = '"' ] && [ "$c" = $'\\' ]; then
        _cp_stripped="$_cp_stripped$c${s:i+1:1}"; i=$((i + 2)); continue
      fi
      [ "$c" = "$q" ] && q=''
      _cp_stripped="$_cp_stripped$c"; i=$((i + 1)); continue
    fi
    case $c in
      \'|\") q=$c; _cp_stripped="$_cp_stripped$c"; i=$((i + 1)); continue ;;
      \\)    _cp_stripped="$_cp_stripped$c${s:i+1:1}"; i=$((i + 2)); continue ;;
    esac

    # `<<<` is a herestring — one word, no body, not a heredoc.
    if [ "$c" = '<' ] && [ "${s:i+1:1}" = '<' ] && [ "${s:i+2:1}" != '<' ]; then
      off=${#_cp_stripped}
      _cp_stripped="$_cp_stripped<<"; i=$((i + 2))
      # `<<-` strips leading TABS (not spaces) from body lines and from the terminator.
      local strip=0
      if [ "${s:i:1}" = '-' ]; then strip=1; _cp_stripped="$_cp_stripped-"; i=$((i + 1)); fi
      while [ "${s:i:1}" = ' ' ] || [ "${s:i:1}" = $'\t' ]; do
        _cp_stripped="$_cp_stripped${s:i:1}"; i=$((i + 1))
      done
      # Delimiter word: 'EOF', "EOF" or bare EOF. Quoting only affects expansion inside the
      # body, which this parser never performs, so all three are read the same way.
      local dq='' delim=''
      c=${s:i:1}
      if [ "$c" = "'" ] || [ "$c" = '"' ]; then
        dq=$c; _cp_stripped="$_cp_stripped$c"; i=$((i + 1))
        while [ "$i" -lt "$n" ] && [ "${s:i:1}" != "$dq" ]; do
          delim="$delim${s:i:1}"; _cp_stripped="$_cp_stripped${s:i:1}"; i=$((i + 1))
        done
        if [ "$i" -ge "$n" ]; then _cp_reason=unbalanced-quote; return 1; fi
        _cp_stripped="$_cp_stripped$dq"; i=$((i + 1))
      else
        while [ "$i" -lt "$n" ]; do
          c=${s:i:1}
          case $c in
            ' '|$'\t'|$'\n'|';'|'&'|'|'|'>'|'<'|'(' ) break ;;
          esac
          delim="$delim$c"; _cp_stripped="$_cp_stripped$c"; i=$((i + 1))
        done
      fi
      pend_delim="$pend_delim$CP_US$delim"
      pend_strip="$pend_strip$CP_US$strip"
      # The offset recorded is the operator's, so the body lands on the segment that
      # actually redirects it rather than on whatever the newline split off.
      _cp_hd_off[_cp_hd_n]=$off
      _cp_hd_body[_cp_hd_n]=''
      _cp_hd_n=$((_cp_hd_n + 1))
      pend_n=$((pend_n + 1))
      continue
    fi

    if [ "$c" = $'\n' ] && [ "$pend_n" -gt 0 ]; then
      # The newline still terminates the command line; only the bodies after it are lifted.
      _cp_stripped="$_cp_stripped$c"; i=$((i + 1))
      k=$((_cp_hd_n - pend_n))
      while [ "$pend_n" -gt 0 ]; do
        ldelim=${pend_delim#"$CP_US"}; ldelim=${ldelim%%"$CP_US"*}
        pend_delim=${pend_delim#"$CP_US"}; pend_delim=${pend_delim#"$ldelim"}
        local st=${pend_strip#"$CP_US"}; st=${st%%"$CP_US"*}
        pend_strip=${pend_strip#"$CP_US"}; pend_strip=${pend_strip#"$st"}
        body=''
        while [ "$i" -le "$n" ]; do
          line=''
          while [ "$i" -lt "$n" ] && [ "${s:i:1}" != $'\n' ]; do
            line="$line${s:i:1}"; i=$((i + 1))
          done
          [ "$i" -lt "$n" ] && i=$((i + 1))   # step over the newline
          local cmp=$line
          [ "$st" = 1 ] && while [ "${cmp#	}" != "$cmp" ]; do cmp=${cmp#	}; done
          [ "$cmp" = "$ldelim" ] && break
          body="$body$line"$'\n'
          # An unterminated heredoc runs to end of input; the body is what there is.
          [ "$i" -ge "$n" ] && break
        done
        _cp_hd_body[k]=$body
        k=$((k + 1))
        pend_n=$((pend_n - 1))
      done
      continue
    fi

    _cp_stripped="$_cp_stripped$c"; i=$((i + 1))
  done

  [ -n "$q" ] && { _cp_reason=unbalanced-quote; return 1; }
  return 0
}

# --- segmentation -----------------------------------------------------------------------
_cp_emit() {
  # $1 text, $2 separator, $3 start offset, $4 end offset
  local j=$CP_NSEG hd='' k
  CP_SEG[j]=$1
  CP_SEP[j]=$2
  k=0
  while [ "$k" -lt "$_cp_hd_n" ]; do
    if [ "${_cp_hd_off[k]}" -ge "$3" ] && [ "${_cp_hd_off[k]}" -lt "$4" ]; then
      if [ -n "$hd" ]; then hd="$hd$CP_US${_cp_hd_body[k]}"; else hd=${_cp_hd_body[k]}; fi
    fi
    k=$((k + 1))
  done
  CP_HEREDOC[j]=$hd
  CP_NSEG=$((j + 1))
}

_cp_segment() {
  local s="$1"
  local n=${#s}   # separate `local`: see _cp_lift
  local i=0 q='' cur='' c next prev start=0

  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    if [ -n "$q" ]; then
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
    # Command and process substitution can smuggle an unlisted command inside an otherwise
    # allowed segment. This parser does not expand, so it must not pretend to have read the
    # command: refuse, and let the caller defer.
    if [ "$c" = '`' ] \
      || { [ "$c" = '$' ] && [ "$next" = '(' ]; } \
      || { { [ "$c" = '<' ] || [ "$c" = '>' ]; } && [ "$next" = '(' ]; }; then
      _cp_reason=substitution; return 1
    fi

    if { [ "$c" = '&' ] && [ "$next" = '&' ]; } || { [ "$c" = '|' ] && [ "$next" = '|' ]; }; then
      _cp_emit "$cur" "$c$next" "$start" "$i"
      cur=''; i=$((i + 2)); start=$i; continue
    fi
    # A lone `&` backgrounds what is to its left and starts a new command, so it separates.
    # `>&N` / `<&N` are fd dups and must not. The old splitter refused the whole command on
    # a lone `&`, which was safe but coarse; treating it as a separator is strictly narrower.
    if [ "$c" = '&' ]; then
      prev=''
      [ -n "$cur" ] && prev=${cur:$((${#cur} - 1)):1}
      if [ "$prev" != '>' ] && [ "$prev" != '<' ]; then
        _cp_emit "$cur" '&' "$start" "$i"
        cur=''; i=$((i + 1)); start=$i; continue
      fi
    fi
    if [ "$c" = ';' ] || [ "$c" = '|' ]; then
      _cp_emit "$cur" "$c" "$start" "$i"
      cur=''; i=$((i + 1)); start=$i; continue
    fi
    # The fix this module exists for. Heredoc bodies are already gone, so every newline left
    # here separates two real commands.
    if [ "$c" = $'\n' ]; then
      _cp_emit "$cur" 'newline' "$start" "$i"
      cur=''; i=$((i + 1)); start=$i; continue
    fi
    cur="$cur$c"; i=$((i + 1))
  done

  [ -n "$q" ] && { _cp_reason=unbalanced-quote; return 1; }
  _cp_emit "$cur" 'eof' "$start" "$n"

  # A trailing separator terminates the last command; it does not start an empty new one.
  # This matters beyond tidiness. `ls\n` and `ls;` are single commands, and a trailing
  # newline is ordinary in a multi-line prompt — but they would otherwise report 2 segments,
  # and the compound gate in allow-compound-bash.sh keys on exactly that. Running the
  # approver over a genuinely single command WIDENS it: it would auto-approve things native
  # prefix matching would have prompted for. The empty tail is dropped and the separator it
  # consumed becomes `eof`, because nothing follows it.
  # A loop, not a single check: `ls &&\n` ends in two separators back to back and would
  # otherwise still report 2 segments. Only empty tails collapse, so a real trailing command
  # always stops it.
  local last tail
  while [ "$CP_NSEG" -gt 1 ]; do
    last=$((CP_NSEG - 1))
    [ -n "${CP_HEREDOC[last]}" ] && break
    tail=${CP_SEG[last]}
    tail=${tail//[$' \t\r\n']/}
    [ -n "$tail" ] && break
    CP_NSEG=$last
    CP_SEP[CP_NSEG - 1]='eof'
  done
  return 0
}

cmd_parse() {
  CP_STATUS=''
  CP_NSEG=0
  CP_SEG=()
  CP_SEP=()
  CP_HEREDOC=()
  _cp_reason=''
  if ! _cp_lift "$1"; then
    CP_STATUS="unreadable:$_cp_reason"
    return 1
  fi
  if ! _cp_segment "$_cp_stripped"; then
    CP_STATUS="unreadable:$_cp_reason"
    CP_NSEG=0
    return 1
  fi
  CP_STATUS=ok
  return 0
}

# --- CLI --------------------------------------------------------------------------------
# `cmdparse.sh --json` reads a command on stdin and writes the decomposition as JSON. This
# entry point exists ONLY for tests and the rule linter — never on the permission hot path,
# where the library is sourced and costs no process.
_cp_json_str() {
  local s=$1
  local n=${#s}
  local out='' i=0 c
  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    case $c in
      '"')    out="$out\\\"" ;;
      $'\\')  out="$out\\\\" ;;
      $'\n')  out="$out\\n" ;;
      $'\r')  out="$out\\r" ;;
      $'\t')  out="$out\\t" ;;
      "$CP_US") out="$out\\u001f" ;;
      *)      out="$out$c" ;;
    esac
    i=$((i + 1))
  done
  printf '"%s"' "$out"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${1:-}" != '--json' ]; then
    printf 'usage: cmdparse.sh --json   (command on stdin)\n' >&2
    exit 2
  fi
  _cp_input=$(cat; printf x); _cp_input=${_cp_input%x}   # preserve trailing newlines
  cmd_parse "$_cp_input" || true
  printf '{"status":'; _cp_json_str "$CP_STATUS"
  printf ',"nseg":%s,"seg":[' "$CP_NSEG"
  _cp_i=0
  while [ "$_cp_i" -lt "$CP_NSEG" ]; do
    [ "$_cp_i" -gt 0 ] && printf ','
    _cp_json_str "${CP_SEG[_cp_i]}"
    _cp_i=$((_cp_i + 1))
  done
  printf '],"sep":['
  _cp_i=0
  while [ "$_cp_i" -lt "$CP_NSEG" ]; do
    [ "$_cp_i" -gt 0 ] && printf ','
    _cp_json_str "${CP_SEP[_cp_i]}"
    _cp_i=$((_cp_i + 1))
  done
  printf '],"heredoc":['
  _cp_i=0
  while [ "$_cp_i" -lt "$CP_NSEG" ]; do
    [ "$_cp_i" -gt 0 ] && printf ','
    _cp_json_str "${CP_HEREDOC[_cp_i]}"
    _cp_i=$((_cp_i + 1))
  done
  printf ']}\n'
fi
