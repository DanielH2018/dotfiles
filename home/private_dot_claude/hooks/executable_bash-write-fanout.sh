#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: Bash
#   timeout: 300
#   order: 20
#   statusMessage: Checking files written by Bash...
# Every PostToolUse hook on `Edit|Write` reads `.tool_input.file_path`, which a Bash
# write does not carry — so a heredoc, a `sed -i` or a `tee` runs none of
# them. chezmoi-guard is the one that costs work: without it the source never
# tracks the edit and the next `chezmoi apply` silently reverts it. This
# extracts the written paths from the command text and re-drives all four.
# Timeout matches lint-after-edit.sh, the slowest thing it can call.
# PostToolUse hook (matcher Bash): re-drive the Edit|Write hooks for files a Bash
# command wrote.
#
# Four hooks hang off PostToolUse matcher `Edit|Write` — auto-format.sh,
# lint-after-edit.sh, chezmoi-guard.sh, link-artifact.sh — and every one of them reads
# the path from `.tool_input.file_path`. A `cat > file <<'EOF'`, a `sed -i`, or a `tee`
# carries no file_path and matches neither event, so none of the four run. The gap is not
# theoretical: auto mode injects a standing instruction telling the model to make file
# changes "with sed, heredocs, or short scripts, rather than using the dedicated Read,
# Edit, or Write tools", which points straight at it.
#
# chezmoi-guard.sh is the one that makes this load-bearing. It runs `chezmoi add` after an
# edit to a deployed managed file so the source tracks the change; a Bash write to
# ~/.claude/hooks/foo.sh leaves the source untouched and the next `chezmoi apply` silently
# reverts the edit. Silent reversion of finished work is the failure this whole hook set
# exists to prevent.
#
# What it does: parse the command, extract the paths it plausibly wrote, and for each one
# synthesize the payload the Edit|Write hooks expect and pipe it to each of them. Their
# outputs are merged into one JSON document, because a hook may emit only one.
#
# Deliberately best-effort. A write hidden inside `python3 -c` or a called script is not
# visible in the command text and is not detected — this narrows the bypass, it does not
# close it. The failure direction is a missed fanout, never a wrong one: a path is only
# ever handed on if it exists as a regular file after the command ran.
#
# Opt out with CLAUDE_BASH_WRITE_FANOUT=0.

set -u

# Cheapest possible bail, before sourcing anything. This fires on EVERY Bash call, and
# the overwhelming majority are reads with no write token anywhere in them.
case "${CLAUDE_BASH_WRITE_FANOUT:-1}" in 0) exit 0 ;; esac

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

CMD=$(hook_field '.tool_input.command // empty')
[ -n "$CMD" ] || exit 0

# Second bail: no write construct in the text at all. `>` alone covers redirects and is
# by far the most common; the other three are checked because they write without one.
case "$CMD" in
  *'>'*|*tee*|*'sed '*|*'dd '*) ;;
  *) exit 0 ;;
esac

HOOK_DIR=${BASH_SOURCE[0]%/*}
CWD=$(hook_field '.cwd // empty')
SESSION=$(hook_field '.session_id // empty')
[ -n "$CWD" ] || CWD=$PWD

# ── path extraction ──────────────────────────────────────────────────────────────────
#
# Tokenize respecting quotes, then read the token stream for write constructs. A shell
# parser this is not; it recognizes the shapes that actually appear in a model's file
# writes and ignores everything else.

declare -a TOKENS=()

# A lone backslash, named rather than written inline: as a literal in a test or a case
# pattern it reads as an attempt to escape the surrounding quote and shellcheck says so.
BACKSLASH=$'\x5c'

strip_heredocs() {
  # Drop every heredoc BODY, keeping the line that opens it.
  #
  # This has to happen before tokenizing, and it is the difference between a useful hook
  # and a destructive one. The payload's command string contains the whole file for a
  # `cat > doc.md <<'EOF'` write, and file content is not shell: a Markdown blockquote
  # line is a bare `>`, so the tokenizer would read `> README.md` out of the prose and
  # hand an untouched file to auto-format and chezmoi-guard. Rewriting a file the command
  # never wrote is precisely the failure this hook exists to prevent.
  #
  # It also bounds the cost. The tokenizer walks one character at a time, which is fine
  # for a command line and quadratic on the tens of kilobytes a heredoc body can carry.
  #
  # The opening line survives, so the `> file` that names the real target is still seen.
  local input=$1 out='' line delim='' dash=0 trimmed
  while IFS= read -r line; do
    if [ -n "$delim" ]; then
      trimmed=$line
      # `<<-` lets the terminator be indented with tabs.
      [ "$dash" = 1 ] && trimmed=${line#"${line%%[![:space:]]*}"}
      [ "$trimmed" = "$delim" ] && delim=''
      continue
    fi
    out+=$line$'\n'
    # `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`, with or without a space after the operator.
    if [[ $line =~ \<\<(-?)[[:space:]]*[\'\"]?([A-Za-z_][A-Za-z0-9_-]*) ]]; then
      dash=0
      [ "${BASH_REMATCH[1]}" = "-" ] && dash=1
      delim=${BASH_REMATCH[2]}
    fi
  done <<<"$input"
  printf '%s' "$out"
}

tokenize() {
  local s=$1
  local n=${#s}
  local i=0 c cur='' have=0
  TOKENS=()
  while [ "$i" -lt "$n" ]; do
    c=${s:i:1}
    case $c in
      "'")
        # Single quotes are literal to the next single quote, with no escapes inside.
        have=1; i=$((i + 1))
        while [ "$i" -lt "$n" ] && [ "${s:i:1}" != "'" ]; do cur+=${s:i:1}; i=$((i + 1)); done
        i=$((i + 1)) ;;
      '"')
        have=1; i=$((i + 1))
        while [ "$i" -lt "$n" ] && [ "${s:i:1}" != '"' ]; do
          # A backslash inside double quotes escapes the next character.
          if [ "${s:i:1}" = "$BACKSLASH" ] && [ $((i + 1)) -lt "$n" ]; then
            cur+=${s:i+1:1}; i=$((i + 2))
          else
            cur+=${s:i:1}; i=$((i + 1))
          fi
        done
        i=$((i + 1)) ;;
      "$BACKSLASH")
        have=1; cur+=${s:i+1:1}; i=$((i + 2)) ;;
      ' '|$'\t'|$'\n'|$'\r')
        if [ "$have" = 1 ]; then TOKENS+=("$cur"); cur=''; have=0; fi
        i=$((i + 1)) ;;
      '>'|'<'|'|'|';'|'&')
        # Operators are their own tokens so a `>file` with no space still splits.
        if [ "$have" = 1 ]; then TOKENS+=("$cur"); cur=''; have=0; fi
        if [ "$c" = '>' ] && [ "${s:i+1:1}" = '>' ]; then
          TOKENS+=('>>'); i=$((i + 2))
        else
          TOKENS+=("$c"); i=$((i + 1))
        fi ;;
      *)
        have=1; cur+=$c; i=$((i + 1)) ;;
    esac
  done
  if [ "$have" = 1 ]; then TOKENS+=("$cur"); fi
  return 0
}

declare -a CANDIDATES=()

extract_paths() {
  tokenize "$(strip_heredocs "$1")"
  local i=0 n=${#TOKENS[@]} t tgt cmdword='' inplace=0
  while [ "$i" -lt "$n" ]; do
    t=${TOKENS[i]}
    case $t in
      '>'|'>>')
        # The target is the next token — unless it is `&1`/`&2`, an fd dup, not a file.
        tgt=${TOKENS[i+1]:-}
        case $tgt in
          ''|'&'*|'|'|';'|'>'|'>>'|'<') ;;
          *) CANDIDATES+=("$tgt") ;;
        esac
        i=$((i + 2)); continue ;;
      '|'|';'|'&'|'<')
        # A new command starts here: reset the per-command state.
        cmdword=''; inplace=0; i=$((i + 1)); continue ;;
    esac
    if [ -z "$cmdword" ]; then
      cmdword=${t##*/}
      i=$((i + 1)); continue
    fi
    case $cmdword in
      tee)
        # Every non-flag argument to tee is a file it writes.
        case $t in -*) ;; *) CANDIDATES+=("$t") ;; esac ;;
      sed|gsed|perl)
        # In-place editing only. Without -i, sed and perl write nothing.
        case $t in
          -i|-i.*|--in-place|--in-place=*) inplace=1 ;;
          -*) ;;
          *) if [ "$inplace" = 1 ]; then CANDIDATES+=("$t"); fi ;;
        esac ;;
      dd)
        case $t in of=*) CANDIDATES+=("${t#of=}") ;; esac ;;
    esac
    i=$((i + 1))
  done
  # `sed -i` puts the script before the files, so the script itself lands in CANDIDATES.
  # It is filtered out by the exists-as-a-regular-file test below, same as everything
  # else this over-collects.
  return 0
}

extract_paths "$CMD"
if [ "${#CANDIDATES[@]}" -eq 0 ]; then exit 0; fi

# ── resolve, filter, dedupe ──────────────────────────────────────────────────────────
#
# A candidate is handed on only if it exists as a regular file now. That single test does
# most of the filtering: it drops /dev/null (a character device), a `>` into a process
# substitution, a sed script mistaken for a filename, and anything the command failed to
# create. Over-collecting above and filtering here is deliberate — the alternative is a
# precise shell parser, and a missed write costs more than a wasted `chezmoi source-path`.

declare -a PATHS=()
seen=''
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] || continue
  case $c in
    /*) p=$c ;;
    '~'/*) p="$HOME/${c#\~/}" ;;
    *'$'*) continue ;;   # unexpanded variable: we do not know what it points at
    *) p="$CWD/$c" ;;
  esac
  [ -f "$p" ] || continue
  # Physical path, so two spellings of the same file fan out once.
  d=$(cd "$(dirname "$p")" 2>/dev/null && pwd -P) || continue
  p="$d/$(basename "$p")"
  case "$seen" in *"|$p|"*) continue ;; esac
  seen="$seen|$p|"
  PATHS+=("$p")
  # A command that writes a dozen files is a bulk operation, not an edit; running four
  # hooks over each would stall the session for no benefit.
  if [ "${#PATHS[@]}" -ge 8 ]; then break; fi
done
if [ "${#PATHS[@]}" -eq 0 ]; then exit 0; fi

# Test seam: print what would be fanned out and stop. Extraction is the half worth
# testing directly — the downstream hooks stay silent on most inputs, so running the
# whole hook and reading its stdout cannot tell a correct extraction from an empty one.
if [ -n "${CLAUDE_BASH_WRITE_FANOUT_DRYRUN:-}" ]; then
  printf '%s\n' "${PATHS[@]}"
  exit 0
fi

# ── fan out ──────────────────────────────────────────────────────────────────────────

DOWNSTREAM=(auto-format.sh lint-after-edit.sh chezmoi-guard.sh link-artifact.sh)

OUTPUTS=$(mktemp) || exit 0
# Two codes, because 0.11.0 split the old SC2317 in two: unreachable code kept that code,
# while a function nothing calls directly became SC2329. The single suppression stopped
# covering this line and the pre-push lint went red on a file nobody had touched.
#
# Keep prose OFF the directive line's own form: any comment whose first word is `shellcheck`
# is parsed as a directive, so a continuation line starting that way is a parse error (SC1073).
# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap below, not called directly
cleanup() { [ -n "${OUTPUTS:-}" ] && command rm -f -- "$OUTPUTS"; }
trap cleanup EXIT

for p in "${PATHS[@]}"; do
  # tool_name says Write because that is what the downstream hooks are written against;
  # tool_response.filePath is carried too, since link-artifact.sh reads either.
  payload=$(jq -n --arg p "$p" --arg s "$SESSION" --arg c "$CWD" '{
    session_id: $s, cwd: $c, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_input: { file_path: $p }, tool_response: { filePath: $p }
  }') || continue
  for h in "${DOWNSTREAM[@]}"; do
    [ -x "$HOOK_DIR/$h" ] || continue
    printf '%s' "$payload" | "$HOOK_DIR/$h" >>"$OUTPUTS" 2>/dev/null
    printf '\n' >>"$OUTPUTS"
  done
done

if [ ! -s "$OUTPUTS" ]; then exit 0; fi

# Merge. A hook may emit at most one JSON document, so four hooks' worth of output has to
# collapse into one: any `block` decision wins and its reasons are concatenated, otherwise
# every additionalContext and every line of plain text is joined into a single context
# string. Plain stdout is kept rather than dropped — auto-format.sh reports a missing
# formatter that way, and losing it would make the fanout quieter than a real edit.
jq -Rs '
  [ split("\n")[] | select(length > 0)
    | . as $line | (try ($line | fromjson) catch {plain: $line}) ] as $docs
  | ( [ $docs[] | select(.decision == "block") | .reason | select(. != null) ] ) as $blocks
  | ( [ $docs[]
        | if .hookSpecificOutput.additionalContext then .hookSpecificOutput.additionalContext
          elif .plain then .plain
          else empty end ] ) as $ctx
  | if ($blocks | length) > 0 then
      { decision: "block", reason: ($blocks | join("\n\n")) }
    elif ($ctx | length) > 0 then
      { hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: ($ctx | join("\n")) } }
    else empty end
' "$OUTPUTS"

exit 0
