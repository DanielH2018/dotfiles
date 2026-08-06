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
#   CP_NSEG          number of top-level segments
#   CP_SEG[i]        raw segment text, quotes intact, as the shell would see it — a
#                    substitution's delimiters and content stay in the segment that contains
#                    it; this parser does not strip or evaluate them
#   CP_SEP[i]        separator that TERMINATED segment i: && || ; | & newline eof
#   CP_HEREDOC[i]    heredoc bodies attached to segment i, \x1f-joined ('' if none)
#   CP_NSUBSEG       number of substitution segments (0 if the command has none)
#   CP_SUBSEG[i]     content of one $( ), `...`, or <( )/>( ), segmented the same way as
#                    CP_SEG and flattened across nesting depth — a substitution inside a
#                    substitution gets its own entry alongside its parent's. This is what
#                    actually runs: `echo "$(ls; terraform apply)"` is CP_NSEG=1 (the `;`
#                    inside the substitution is not an outer separator) and
#                    CP_SUBSEG=("ls" "terraform apply"). No separator or heredoc is recorded
#                    per sub-segment.
#
# $(( )) and ${ } are read out to their own boundary — depth-tracked and quote-aware, same as
# a substitution — but are not themselves executing constructs, so closing one does not add a
# CP_SUBSEG entry for its own content. Scanning still continues through it, so a real
# substitution nested inside either ($((n=$(id))), ${x:-$(id)}) is still found and recorded.
# unreadable:substitution now means "a substitution's delimiters never balanced", not "a
# substitution was found" — CP_STATUS=ok is compatible with a command that contains one, and
# CP_SUBSEG is how a consumer sees inside it.
#
# A trailing separator terminates the last CP_SEG rather than starting an empty one
# (`ls;` -> 1 segment, not 2) — allow-compound-bash.sh's compound gate keys on CP_NSEG, and a
# trailing newline is ordinary in a multi-line prompt. CP_SUBSEG does not collapse a trailing
# empty entry; consumers already skip empty segments regardless.
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
CP_NSUBSEG=0
CP_SUBSEG=()

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

    # `$((` opens arithmetic, where `<<`/`>>` are shift operators, not heredoc redirects.
    # Reading one as a heredoc start is a real bug, already present and unguarded for bare
    # `((1<<2))` today — verified against this file before this fix existed. `$((1<<2))` would
    # exhibit the same failure the moment segmentation stops refusing on `$(`, so it closes
    # here. A heredoc body never legitimately appears inside arithmetic, so the whole span is
    # skipped opaque rather than heredoc-scanned; bare `((...))` (no `$`) is a separate,
    # pre-existing gap this change does not touch.
    if [ "$c" = '$' ] && [ "${s:i+1:1}" = '(' ] && [ "${s:i+2:1}" = '(' ]; then
      _cp_stripped="$_cp_stripped\$(("; i=$((i + 3))
      local adepth=1 aq='' ac
      while [ "$i" -lt "$n" ] && [ "$adepth" -gt 0 ]; do
        ac=${s:i:1}
        if [ -n "$aq" ]; then
          if [ "$aq" = '"' ] && [ "$ac" = $'\\' ]; then
            _cp_stripped="$_cp_stripped$ac${s:i+1:1}"; i=$((i + 2)); continue
          fi
          [ "$ac" = "$aq" ] && aq=''
          _cp_stripped="$_cp_stripped$ac"; i=$((i + 1)); continue
        fi
        case $ac in
          \'|\") aq=$ac; _cp_stripped="$_cp_stripped$ac"; i=$((i + 1)); continue ;;
          \\)    _cp_stripped="$_cp_stripped$ac${s:i+1:1}"; i=$((i + 2)); continue ;;
          '(')   adepth=$((adepth + 1)) ;;
          ')')   adepth=$((adepth - 1)) ;;
        esac
        _cp_stripped="$_cp_stripped$ac"; i=$((i + 1))
      done
      [ -n "$aq" ] && { _cp_reason=unbalanced-quote; return 1; }
      continue
    fi

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

# A substitution's content is exposed flattened, not nested: every $( ), backtick, and
# <( )/>( ) found at any depth gets its own entry here, in the order its closing delimiter is
# reached. A consumer that only pattern-matches command names (the shadow census does) does
# not need the tree shape back, only that nothing which actually runs stays invisible to it.
_cp_emit_sub() {
  CP_SUBSEG[CP_NSUBSEG]=$1
  CP_NSUBSEG=$((CP_NSUBSEG + 1))
}

# Recursion guard against adversarial nesting (`$($($($(...))))`): each level re-scans its own
# content from scratch (see _cp_scan), so total work is O(depth * len) — bounded by refusing
# past this depth, not by capping input size.
CP_MAX_SUBST_DEPTH=15

# _cp_scan segments s[start:end) as one command list: either the top-level command
# (IS_TOP=1, emitting into CP_SEG/CP_SEP/CP_HEREDOC via _cp_emit) or one substitution's
# content (IS_TOP=0, emitting flattened into CP_SUBSEG via _cp_emit_sub). A stack of open
# frames tracks nesting — quote and squote/dquote/paren/brace kinds — because bash starts a
# genuinely fresh quoting context inside a substitution: `echo "$(echo "inner")"` is valid,
# and the inner double quotes must not be read as closing the outer pair. `;`/`&&`/`|`/newline
# only separate at THIS call's own stack depth 0 — one inside an open quote or substitution,
# at any depth, is data, not a boundary.
#
# Closing an executing frame (backtick, $( ), <( )/>( )) recurses into this same function over
# its own content with IS_TOP=0, which is what exposes what actually runs. $(( )) and ${ } are
# read out to their own boundary the same depth-tracked, quote-aware way, but are not
# themselves executing constructs, so closing one does not emit a CP_SUBSEG entry for its own
# content — scanning still continues through it, so a real substitution nested inside either
# ($((n=$(id))), ${x:-$(id)}) is still found and still recorded.
_cp_scan() {
  local s="$1" start_="$2" end_="$3" is_top="$4" sdepth="$5"
  local i=$start_ n=$end_
  local cur='' seg_start=$start_ c next prev top
  local stk_kind stk_cnt stk_start stk_n=0 _cp_anc _cp_ak
  stk_kind=(); stk_cnt=(); stk_start=()

  if [ "$sdepth" -gt "$CP_MAX_SUBST_DEPTH" ]; then _cp_reason=substitution; return 1; fi

  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    next=${s:i+1:1}
    top=''
    [ "$stk_n" -gt 0 ] && top=${stk_kind[stk_n - 1]}

    # Inside '...', nothing is special but the closing quote — not even a backslash.
    if [ "$top" = squote ]; then
      cur="$cur$c"; i=$((i + 1))
      [ "$c" = "'" ] && stk_n=$((stk_n - 1))
      continue
    fi

    if [ "$c" = $'\\' ]; then
      cur="$cur$c${s:i+1:1}"; i=$((i + 2)); continue
    fi

    if [ "$c" = "'" ]; then
      # A literal apostrophe inside "...", not a quote — single quotes don't nest-quote there.
      if [ "$top" = dquote ]; then
        cur="$cur$c"; i=$((i + 1)); continue
      fi
      stk_kind[stk_n]=squote; stk_start[stk_n]=$((i + 1)); stk_n=$((stk_n + 1))
      cur="$cur$c"; i=$((i + 1)); continue
    fi

    if [ "$c" = '"' ]; then
      if [ "$top" = dquote ]; then
        stk_n=$((stk_n - 1))
        cur="$cur$c"; i=$((i + 1)); continue
      fi
      stk_kind[stk_n]=dquote; stk_start[stk_n]=$((i + 1)); stk_n=$((stk_n + 1))
      cur="$cur$c"; i=$((i + 1)); continue
    fi

    if [ "$c" = '`' ]; then
      if [ "$top" = backtick ]; then
        stk_n=$((stk_n - 1))
        # Only recurse if no still-open ancestor is itself executing ($( ), <( )/>( ), `...`).
        # An executing ancestor will re-scan this exact range as part of its OWN content when
        # it closes, so recursing here too would double the work and duplicate the entry.
        # $(( ) and ${ } never re-scan (they are not executing), so nesting inside either
        # does not defer.
        _cp_anc=0; _cp_ak=0
        while [ "$_cp_ak" -lt "$stk_n" ]; do
          case ${stk_kind[_cp_ak]} in paren|procsub|backtick) _cp_anc=1 ;; esac
          _cp_ak=$((_cp_ak + 1))
        done
        if [ "$_cp_anc" -eq 0 ]; then
          if ! _cp_scan "$s" "${stk_start[stk_n]}" "$i" 0 "$((sdepth + 1))"; then return 1; fi
        fi
        cur="$cur$c"; i=$((i + 1)); continue
      fi
      stk_kind[stk_n]=backtick; stk_start[stk_n]=$((i + 1)); stk_n=$((stk_n + 1))
      cur="$cur$c"; i=$((i + 1)); continue
    fi

    # $( ) is command substitution (executing); $(( is arithmetic — `<<`/`>>` inside it are
    # shift operators, never heredoc redirects, which is what _cp_lift's own $(( skip exists
    # to keep straight before this ever sees it. Both close on the same paren-depth-zero `)`;
    # only the executing flag differs, decided once here at push and read back at pop.
    if [ "$c" = '$' ] && [ "$next" = '(' ]; then
      if [ "${s:i+2:1}" = '(' ]; then stk_kind[stk_n]=dparen; else stk_kind[stk_n]=paren; fi
      stk_cnt[stk_n]=0; stk_start[stk_n]=$((i + 2)); stk_n=$((stk_n + 1))
      cur="$cur$c$next"; i=$((i + 2)); continue
    fi

    # ${ } is parameter expansion, not execution — never refused, never a CP_SUBSEG entry of
    # its own — but scanned the same way so a substitution nested inside it is still found.
    if [ "$c" = '$' ] && [ "$next" = '{' ]; then
      stk_kind[stk_n]=brace; stk_cnt[stk_n]=0; stk_start[stk_n]=$((i + 2)); stk_n=$((stk_n + 1))
      cur="$cur$c$next"; i=$((i + 2)); continue
    fi

    # <( )/>( ) are only live at a command position, never inside "..." — real bash reads a
    # quoted "<(...)" as literal text, not process substitution.
    if { [ "$c" = '<' ] || [ "$c" = '>' ]; } && [ "$next" = '(' ] && [ "$top" != dquote ]; then
      stk_kind[stk_n]=procsub; stk_cnt[stk_n]=0; stk_start[stk_n]=$((i + 2)); stk_n=$((stk_n + 1))
      cur="$cur$c$next"; i=$((i + 2)); continue
    fi

    if [ "$top" = paren ] || [ "$top" = dparen ] || [ "$top" = procsub ]; then
      if [ "$c" = '(' ]; then
        stk_cnt[stk_n - 1]=$((${stk_cnt[stk_n - 1]} + 1))
        cur="$cur$c"; i=$((i + 1)); continue
      fi
      if [ "$c" = ')' ]; then
        if [ "${stk_cnt[stk_n - 1]}" -gt 0 ]; then
          stk_cnt[stk_n - 1]=$((${stk_cnt[stk_n - 1]} - 1))
          cur="$cur$c"; i=$((i + 1)); continue
        fi
        stk_n=$((stk_n - 1))
        if [ "$top" != dparen ]; then
          # Same deferral as the backtick case above: skip if an executing ancestor remains.
          _cp_anc=0; _cp_ak=0
          while [ "$_cp_ak" -lt "$stk_n" ]; do
            case ${stk_kind[_cp_ak]} in paren|procsub|backtick) _cp_anc=1 ;; esac
            _cp_ak=$((_cp_ak + 1))
          done
          if [ "$_cp_anc" -eq 0 ]; then
            if ! _cp_scan "$s" "${stk_start[stk_n]}" "$i" 0 "$((sdepth + 1))"; then return 1; fi
          fi
        fi
        cur="$cur$c"; i=$((i + 1)); continue
      fi
    fi

    if [ "$top" = brace ]; then
      if [ "$c" = '{' ]; then
        stk_cnt[stk_n - 1]=$((${stk_cnt[stk_n - 1]} + 1))
        cur="$cur$c"; i=$((i + 1)); continue
      fi
      if [ "$c" = '}' ]; then
        if [ "${stk_cnt[stk_n - 1]}" -gt 0 ]; then
          stk_cnt[stk_n - 1]=$((${stk_cnt[stk_n - 1]} - 1))
          cur="$cur$c"; i=$((i + 1)); continue
        fi
        stk_n=$((stk_n - 1))
        cur="$cur$c"; i=$((i + 1)); continue
      fi
    fi

    if [ "$stk_n" -eq 0 ]; then
      if { [ "$c" = '&' ] && [ "$next" = '&' ]; } || { [ "$c" = '|' ] && [ "$next" = '|' ]; }; then
        if [ "$is_top" = 1 ]; then _cp_emit "$cur" "$c$next" "$seg_start" "$i"; else _cp_emit_sub "$cur"; fi
        cur=''; i=$((i + 2)); seg_start=$i; continue
      fi
      # A lone `&` backgrounds what is to its left and starts a new command, so it separates.
      # `>&N` / `<&N` are fd dups and must not.
      if [ "$c" = '&' ]; then
        prev=''
        [ -n "$cur" ] && prev=${cur:$((${#cur} - 1)):1}
        if [ "$prev" != '>' ] && [ "$prev" != '<' ]; then
          if [ "$is_top" = 1 ]; then _cp_emit "$cur" '&' "$seg_start" "$i"; else _cp_emit_sub "$cur"; fi
          cur=''; i=$((i + 1)); seg_start=$i; continue
        fi
      fi
      if [ "$c" = ';' ] || [ "$c" = '|' ]; then
        if [ "$is_top" = 1 ]; then _cp_emit "$cur" "$c" "$seg_start" "$i"; else _cp_emit_sub "$cur"; fi
        cur=''; i=$((i + 1)); seg_start=$i; continue
      fi
      # The fix this module exists for. Heredoc bodies are already gone, so every newline left
      # here separates two real commands.
      if [ "$c" = $'\n' ]; then
        if [ "$is_top" = 1 ]; then _cp_emit "$cur" 'newline' "$seg_start" "$i"; else _cp_emit_sub "$cur"; fi
        cur=''; i=$((i + 1)); seg_start=$i; continue
      fi
    fi

    cur="$cur$c"; i=$((i + 1))
  done

  if [ "$stk_n" -gt 0 ]; then
    # Prefer the quote reading when both are open: it is the proximate, fixable cause — an
    # unclosed $( ) alongside an unclosed " is usually the quote swallowing the rest.
    local k=0 reason=substitution
    while [ "$k" -lt "$stk_n" ]; do
      { [ "${stk_kind[k]}" = squote ] || [ "${stk_kind[k]}" = dquote ]; } && reason=unbalanced-quote
      k=$((k + 1))
    done
    _cp_reason=$reason
    return 1
  fi

  if [ "$is_top" = 1 ]; then _cp_emit "$cur" 'eof' "$seg_start" "$n"; else _cp_emit_sub "$cur"; fi
  return 0
}

_cp_segment() {
  local s="$1"
  local n=${#s}   # separate `local`: see _cp_lift
  if ! _cp_scan "$s" 0 "$n" 1 0; then return 1; fi

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
  CP_NSUBSEG=0
  CP_SUBSEG=()
  _cp_reason=''
  if ! _cp_lift "$1"; then
    CP_STATUS="unreadable:$_cp_reason"
    return 1
  fi
  if ! _cp_segment "$_cp_stripped"; then
    CP_STATUS="unreadable:$_cp_reason"
    CP_NSEG=0
    CP_NSUBSEG=0
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
  printf '],"subseg":['
  _cp_i=0
  while [ "$_cp_i" -lt "$CP_NSUBSEG" ]; do
    [ "$_cp_i" -gt 0 ] && printf ','
    _cp_json_str "${CP_SUBSEG[_cp_i]}"
    _cp_i=$((_cp_i + 1))
  done
  printf ']}\n'
fi
