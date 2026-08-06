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
# The scan itself is one awk pass, not a bash character loop: `${s:i:1}` costs O(i) per call,
# so a bash loop over a command is quadratic. Measured on an 11.8KB heredoc — the shape `gh pr
# create --body-file - <<EOF` produces routinely — a bash version of this scan cost ~2.8s per
# call; the same input through awk costs single-digit milliseconds. block-dangerous-bash.sh
# hit the identical bug and fixed it the same way, so this adds no new interpreter dependency
# to the hot path — awk is already there. "A missing interpreter is a new fail-open surface"
# does not apply here the way it might look: cmdparse's contract makes any failure a refusal
# (CP_STATUS=unreadable:no-awk), never a skip, so an awk that cannot run degrades in the safe
# direction, same as a missing jq degrading to "ask" rather than "allow". awk hands the
# decomposition back through stdout as \x1f/\x1e-delimited records; bash reads them into the
# CP_* arrays below and owns the trailing-empty-segment collapse, which stays small enough not
# to be worth moving.
#
# Bash 3.2 clean (macOS default bash): no mapfile, no associative arrays, no `${arr[@]}` on a
# possibly-empty array under `set -u` — counters are tracked explicitly instead. The awk is
# POSIX — no gensub, no `\<`/`\>`, no multi-char RS — since macOS ships BSD awk, not gawk.
#
# CONTRACT, and the whole reason this is safe to adopt one call site at a time:
#   cmd_parse "$COMMAND"  -> 0 and CP_STATUS=ok
#                         -> non-zero and CP_STATUS=unreadable:<reason>
#   A NON-ZERO RETURN IS A REFUSAL, NEVER A SKIP. The caller must defer (PermissionRequest)
#   or ask (PreToolUse). It must never be read as "nothing to worry about here".
#
# Populated on success:
#   CP_STATUS        ok | unreadable:unbalanced-quote | unreadable:substitution |
#                    unreadable:no-awk (awk is unavailable; refuse, do not skip)
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
# Heredoc lifting and substitution scanning share the same pass and the same quote/frame
# state, not two passes with two different ideas of "inside a quote". That is load-bearing,
# not tidiness: a heredoc textually inside a double-quoted substitution — the
# `git commit -am "$(cat <<'EOF' … EOF)"` shape a PR/commit body produces routinely — needs
# the scan to know it is back at a command position once it crosses into the `$( )`, so the
# heredoc body still gets lifted out rather than read as shell syntax. A two-pass version of
# this parser shipped that bug: heredoc lifting alone did not know substitutions reopen a
# command position inside a quote, so the body's own prose sailed through unlifted and the
# scan going stricter about quotes inside substitutions turned prose into false unbalanced-quote
# refusals. Fixed by merging the passes rather than teaching the old lift pass more state.
#
# No cap on substitution nesting depth: the scan does not recurse — a closing frame is a
# substr() off its own recorded start offset, not a re-scan of its content — so nothing here
# grows with nesting depth the way a recursive implementation's cost would.
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

# --- decomposition (heredoc lift + substitution-aware segmentation, one awk pass) --------
#
# One pass, one stack, because a two-pass version of this shipped a real bug: heredoc lifting
# and segmentation each had their own idea of "inside a quote", and the compound case —
# `git commit -am "$(cat <<'EOF' … EOF)"`, which a PR/commit body produces routinely — needs
# BOTH to agree that crossing into the `$( )` reopens a command position, or the heredoc body
# never gets lifted and its own prose gets read as shell syntax. See CONTRACT above.
#
# A frame stack (squote, dquote, backtick, paren, dparen, brace, procsub) tracks nesting the
# same way `echo "$(echo "inner")"` needs it tracked: a substitution starts a fresh quoting
# context, so the inner double quotes must not read as closing the outer pair. `;`/`&&`/`|`/
# newline separate, and `<<` opens a heredoc, only at a genuine command position — stack empty
# (true top level) or the innermost open frame is executing (paren/procsub/backtick). $(( ))
# and ${ } are read out to their own boundary the same depth-tracked way but are not
# themselves executing, so `<<`/`>>` inside $(( )) are shift operators, not heredoc redirects,
# and closing either does not itself add a CP_SUBSEG entry — a real substitution nested inside
# either ($((n=$(id))), ${x:-$(id)}) is still found because scanning continues through it.
#
# No recursion: each frame keeps its own running start offset (segStart[depth]), so its
# content is one substr() away when it closes, not a re-scan. That is what makes "no depth
# cap" safe and what makes nested substitutions come out exactly once each rather than needing
# the ancestor-deferral bookkeeping a recursive version would.
#
# Output is \x1f/\x1e-delimited records on stdout (see the protocol comment on _CP_AWK) that
# `cmd_parse` reads back into the CP_* arrays below. \002 is a private framing byte between
# bash and this awk call only — appended by cmd_parse and stripped inside awk — so a trailing
# newline in COMMAND round-trips through awk's line-based input instead of being silently
# eaten by it.
_CP_AWK='
{ lines[NR] = $0 }
END {
  s = ""
  for (j = 1; j <= NR; j++) s = s (j > 1 ? "\n" : "") lines[j]
  sub(/\002$/, "", s)
  n = length(s)

  depth = 0
  segStart[0] = 1
  pendN = 0
  hdCount = 0
  nseg = 0
  nsub = 0
  fatal = 0

  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    top = (depth > 0) ? kind[depth] : ""

    if (top == "squote") {
      if (c == "\047") depth--
      continue
    }

    if (c == "\\") { i++; continue }

    if (c == "\047") {
      if (top == "dquote") continue
      depth++; kind[depth] = "squote"; segStart[depth] = i + 1
      continue
    }

    if (c == "\"") {
      if (top == "dquote") { depth--; continue }
      depth++; kind[depth] = "dquote"; segStart[depth] = i + 1
      continue
    }

    if (c == "`") {
      if (top == "backtick") {
        nsub++; subText[nsub] = substr(s, segStart[depth], i - segStart[depth])
        depth--
        continue
      }
      depth++; kind[depth] = "backtick"; segStart[depth] = i + 1
      continue
    }

    next1 = (i < n) ? substr(s, i + 1, 1) : ""

    if (c == "$" && next1 == "(") {
      next2 = (i + 2 <= n) ? substr(s, i + 2, 1) : ""
      depth++
      kind[depth] = (next2 == "(") ? "dparen" : "paren"
      cnt[depth] = 0
      segStart[depth] = i + 2
      i++
      continue
    }

    if (c == "$" && next1 == "{") {
      depth++; kind[depth] = "brace"; cnt[depth] = 0; segStart[depth] = i + 2
      i++
      continue
    }

    if ((c == "<" || c == ">") && next1 == "(" && top != "dquote") {
      depth++; kind[depth] = "procsub"; cnt[depth] = 0; segStart[depth] = i + 2
      i++
      continue
    }

    if (top == "paren" || top == "dparen" || top == "procsub") {
      if (c == "(") { cnt[depth]++; continue }
      if (c == ")") {
        if (cnt[depth] > 0) { cnt[depth]--; continue }
        if (top != "dparen") {
          nsub++; subText[nsub] = substr(s, segStart[depth], i - segStart[depth])
        }
        depth--
        continue
      }
    }

    if (top == "brace") {
      if (c == "{") { cnt[depth]++; continue }
      if (c == "}") {
        if (cnt[depth] > 0) { cnt[depth]--; continue }
        depth--
        continue
      }
    }

    atCmdPos = (depth == 0 || top == "paren" || top == "procsub" || top == "backtick")

    if (atCmdPos && c == "<" && next1 == "<") {
      next2 = (i + 2 <= n) ? substr(s, i + 2, 1) : ""
      if (next2 != "<") {
        hoff = i
        j = i + 2
        strip = 0
        if (substr(s, j, 1) == "-") { strip = 1; j++ }
        while (substr(s, j, 1) == " " || substr(s, j, 1) == "\t") j++
        dq = ""; delim = ""
        dc = substr(s, j, 1)
        if (dc == "\047" || dc == "\"") {
          dq = dc; j++
          while (j <= n && substr(s, j, 1) != dq) { delim = delim substr(s, j, 1); j++ }
          if (j > n) { fatal = 1; reason = "unbalanced-quote"; break }
          j++
        } else {
          while (j <= n) {
            dc = substr(s, j, 1)
            if (dc == " " || dc == "\t" || dc == "\n" || dc == ";" || dc == "&" || dc == "|" || dc == ">" || dc == "<" || dc == "(") break
            delim = delim dc; j++
          }
        }
        pendN++
        pendDelim[pendN] = delim
        pendStrip[pendN] = strip
        pendOff[pendN] = hoff
        i = j - 1
        continue
      }
    }

    if (atCmdPos) {
      if ((c == "&" && next1 == "&") || (c == "|" && next1 == "|")) {
        piece = substr(s, segStart[depth], i - segStart[depth])
        sepv = c next1
        if (depth == 0) { nseg++; segText[nseg] = piece; segSep[nseg] = sepv; segOff0[nseg] = segStart[0]; segOff1[nseg] = i }
        else { nsub++; subText[nsub] = piece }
        segStart[depth] = i + 2
        i++
        continue
      }
      if (c == "&") {
        prevc = (i > segStart[depth]) ? substr(s, i - 1, 1) : ""
        if (prevc != ">" && prevc != "<") {
          piece = substr(s, segStart[depth], i - segStart[depth])
          if (depth == 0) { nseg++; segText[nseg] = piece; segSep[nseg] = "&"; segOff0[nseg] = segStart[0]; segOff1[nseg] = i }
          else { nsub++; subText[nsub] = piece }
          segStart[depth] = i + 1
          continue
        }
      }
      if (c == ";" || c == "|") {
        piece = substr(s, segStart[depth], i - segStart[depth])
        if (depth == 0) { nseg++; segText[nseg] = piece; segSep[nseg] = c; segOff0[nseg] = segStart[0]; segOff1[nseg] = i }
        else { nsub++; subText[nsub] = piece }
        segStart[depth] = i + 1
        continue
      }
      if (c == "\n") {
        piece = substr(s, segStart[depth], i - segStart[depth])
        if (depth == 0) { nseg++; segText[nseg] = piece; segSep[nseg] = "newline"; segOff0[nseg] = segStart[0]; segOff1[nseg] = i }
        else { nsub++; subText[nsub] = piece }
        segStart[depth] = i + 1

        if (pendN > 0) {
          bodyStart = i + 1
          for (p = 1; p <= pendN; p++) {
            body = ""
            while (1) {
              rest = substr(s, bodyStart)
              lineEnd = index(rest, "\n")
              if (lineEnd == 0) { line = rest; lineHasNL = 0 } else { line = substr(rest, 1, lineEnd - 1); lineHasNL = 1 }
              cmp = line
              if (pendStrip[p] == 1) sub(/^\t+/, "", cmp)
              if (cmp == pendDelim[p]) {
                bodyStart = lineHasNL ? bodyStart + lineEnd : n + 1
                break
              }
              body = body line "\n"
              if (!lineHasNL) { bodyStart = n + 1; break }
              bodyStart = bodyStart + lineEnd
            }
            hdCount++
            hdOff[hdCount] = pendOff[p]
            hdBody[hdCount] = body
          }
          i = bodyStart - 1
          segStart[depth] = bodyStart
          pendN = 0
        }
        continue
      }
    }
  }

  if (fatal) {
    printf "STATUS\037ERR\037%s\036", reason
    exit 0
  }

  if (depth > 0) {
    reason = "substitution"
    for (d = 1; d <= depth; d++) {
      if (kind[d] == "squote" || kind[d] == "dquote") reason = "unbalanced-quote"
    }
    printf "STATUS\037ERR\037%s\036", reason
    exit 0
  }

  nseg++
  segText[nseg] = substr(s, segStart[0], n - segStart[0] + 1)
  segSep[nseg] = "eof"
  segOff0[nseg] = segStart[0]
  segOff1[nseg] = n + 1

  printf "STATUS\037OK\036"
  for (x = 1; x <= nseg; x++) {
    hd = ""
    for (h = 1; h <= hdCount; h++) {
      if (hdOff[h] >= segOff0[x] && hdOff[h] < segOff1[x]) {
        hd = (hd == "") ? hdBody[h] : hd "\037" hdBody[h]
      }
    }
    printf "SEG\037%s\037%s\037%s\036", segText[x], segSep[x], hd
  }
  for (x = 1; x <= nsub; x++) {
    printf "SUB\037%s\036", subText[x]
  }
}
'

cmd_parse() {
  CP_STATUS=''
  CP_NSEG=0
  CP_SEG=()
  CP_SEP=()
  CP_HEREDOC=()
  CP_NSUBSEG=0
  CP_SUBSEG=()

  local rtype rf1 rf2 rf3 ok=0
  # The last named var absorbs everything past the 3rd \x1f verbatim, un-split — load-bearing
  # for the heredoc field, which is itself \x1f-joined when a segment carries more than one
  # body. `read -a` would split those apart into indistinguishable extra elements; this does not.
  while IFS=$'\037' read -r -d $'\036' rtype rf1 rf2 rf3; do
    case $rtype in
      STATUS)
        if [ "$rf1" = OK ]; then ok=1; else CP_STATUS="unreadable:$rf2"; fi
        ;;
      SEG)
        CP_SEG[CP_NSEG]=$rf1
        CP_SEP[CP_NSEG]=$rf2
        CP_HEREDOC[CP_NSEG]=$rf3
        CP_NSEG=$((CP_NSEG + 1))
        ;;
      SUB)
        CP_SUBSEG[CP_NSUBSEG]=$rf1
        CP_NSUBSEG=$((CP_NSUBSEG + 1))
        ;;
    esac
  done < <(printf '%s\002' "$1" | awk -- "$_CP_AWK")

  if [ "$ok" -ne 1 ]; then
    CP_NSEG=0; CP_SEG=(); CP_SEP=(); CP_HEREDOC=()
    CP_NSUBSEG=0; CP_SUBSEG=()
    [ -z "$CP_STATUS" ] && CP_STATUS='unreadable:no-awk'
    return 1
  fi

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
