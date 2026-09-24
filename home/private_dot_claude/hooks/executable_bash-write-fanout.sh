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

# ── heredoc stripping ────────────────────────────────────────────────────────────────
#
# claude_guard.segment already lifts heredoc bodies out of a command, and it is the
# parser the deny hook decides with. The line-at-a-time regex below is a second
# implementation of the same job, and it reads a delimiter the shell would not:
# `[A-Za-z_]` as the first character means `cat > note.md <<'.END'` is not seen as a
# heredoc at all, so a body line `> README.md` -- a Markdown blockquote -- is tokenized
# as a redirect and README.md is handed to auto-format, lint-after-edit and
# chezmoi-guard although the command never wrote it. Measured against this hook before
# the change: `cat > note.md <<'.END'` with that body fanned out BOTH note.md and
# README.md. Rewriting a file the command never wrote is the failure this hook exists to
# prevent, so the parser decides.
#
# Three outcomes, and the difference between them is the whole safety argument:
#
#   parsed ok      the segment texts, rejoined with their own separators. Bodies are
#                  gone; the opening line, and the `> file` on it, survive.
#   unreadable     print NOTHING. No tokens means no candidates means no fanout. A
#                  command the parser refuses to read is one whose writes cannot be
#                  located, and a missed fanout is the safe direction here.
#   no interpreter fall back to the regex below, which is what this hook did before.
#
# Gated on `<<` in the text, not on `>`: `2>/dev/null` is in a large share of ordinary
# commands, and paying for an interpreter on those would put a Python start in front of
# most Bash calls.
GUARD_SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"

parsed_strip_heredocs() {
  [ -f "$GUARD_SHARE/claude_guard/segment.py" ] || return 1
  local py
  py=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || return 1
  [ -x "$py" ] || return 1
  CG_SHARE="$GUARD_SHARE" "$py" -S -P -c '
import os, sys

sys.path.insert(0, os.environ["CG_SHARE"])
from claude_guard.segment import parse

p = parse(sys.stdin.read())
if not p.ok:
    raise SystemExit(0)  # nothing on stdout: the caller fans out nothing

# Put each separator back as text. The tokenizer downstream resets its command word on
# `|`, `;` and `&`, so joining on newlines alone would let one segment/s redirect target
# read as the next one/s.
SEP = {"&&": " && ", "||": " || ", ";": " ; ", "|": " | ", "&": " & ",
       "newline": "\n", "eof": ""}
sys.stdout.write("".join(s.text + SEP.get(s.sep, " ") for s in p.segments))
' 2>/dev/null <<<"$1"
}

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
  local shell_text
  case $1 in
    *'<<'*)
      # The parser's answer wins; only an unavailable interpreter reaches the regex.
      if ! shell_text=$(parsed_strip_heredocs "$1"); then
        shell_text=$(strip_heredocs "$1")
      fi ;;
    *) shell_text=$1 ;;
  esac
  tokenize "$shell_text"
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

# Every downstream hook runs through run_bounded, like every other hook child (#581). They
# used to run bare, so one that hung ran into this hook's own 300s limit, and the harness
# then killed the fan-out and threw away every other hook's output with it. The library is
# required: without it nothing below may run unbounded, so the paths are reported as not
# evaluated. A block, as lint-after-edit.sh does for the same broken install, because the
# chezmoi re-sync skipped here is what stops the next apply reverting the write.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-$HOOK_DIR/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  jq -n --arg lib "$RUN_BOUNDED_PATH" --arg paths "${PATHS[*]}" '{decision: "block",
    reason: ("bash-write-fanout: cannot load \($lib), so the Edit|Write hooks (format, lint, "
      + "chezmoi re-sync) did not run on \($paths) -- not evaluated. Restore it "
      + "(chezmoi apply ~/.claude/hooks) and re-run them by hand.")}'
  exit 0
fi

# Each hook gets the timeout its own gen-hooks header declares, which is what the harness
# would give it on an Edit or Write. The fan-out as a whole gets a deadline under this
# hook's own 300s: eight paths times lint-after-edit's 300s is far past it, and a hook
# started with no time left is reported as not evaluated rather than killed with the rest.
hook_timeout() {
  local t
  t=$(sed -n 's/^#   timeout: *\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null)
  t=${t%%[!0-9]*}
  printf '%s\n' "${t:-30}"
}
FANOUT_DEADLINE=$((SECONDS + ${BASH_WRITE_FANOUT_BUDGET_S:-280}))
FANOUT_CAP_BYTES=1048576

# Collected in a variable, not a tempfile. `OUTPUTS=$(mktemp) || exit 0` used to skip the
# whole fan-out when the tempfile could not be made -- a guard that silently did nothing, on
# the one path where the four hooks it re-drives would otherwise never run (#581). Removing
# the tempfile removes the failure rather than choosing an outcome for it: each downstream
# hook's output is a few lines of JSON or text, so holding it in memory costs nothing.
# run_bounded does make a tempfile of its own. Where it cannot, each hook is reported below
# as not evaluated (error), which is a report rather than a skip.
#
# NOTEVAL collects the hooks that did not run to completion. It is kept apart from the
# hooks' own output because the merge drops plain context when a hook blocks, and a hook
# that was not evaluated must be named whichever way the merge goes.
OUTPUTS=""
NOTEVAL=""
for p in "${PATHS[@]}"; do
  # tool_name says Write because that is what the downstream hooks are written against;
  # tool_response.filePath is carried too, since link-artifact.sh reads either.
  payload=$(jq -n --arg p "$p" --arg s "$SESSION" --arg c "$CWD" '{
    session_id: $s, cwd: $c, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_input: { file_path: $p }, tool_response: { filePath: $p }
  }') || continue
  for h in "${DOWNSTREAM[@]}"; do
    [ -x "$HOOK_DIR/$h" ] || continue
    left=$((FANOUT_DEADLINE - SECONDS))
    if [ "$left" -lt 1 ]; then
      NOTEVAL="${NOTEVAL}bash-write-fanout: out of time before $h ran on $p -- not evaluated
"
      continue
    fi
    t=$(hook_timeout "$HOOK_DIR/$h")
    [ "$t" -le "$left" ] || t=$left
    # The pipe runs inside the bounded child: piped INTO run_bounded, the function would
    # run in a subshell and its RB_* results would be lost. The hook's stderr stays out of
    # RB_OUT, which run_bounded merges, so a warning line cannot corrupt a JSON block.
    # shellcheck disable=SC2016  # $1/$2 belong to the inner bash
    run_bounded "$t" "$FANOUT_CAP_BYTES" -- \
      bash -c 'printf %s "$1" | "$2" 2>/dev/null' _ "$payload" "$HOOK_DIR/$h"
    if [ "$RB_STATUS" != ok ]; then
      NOTEVAL="${NOTEVAL}bash-write-fanout: $h did not finish on $p within ${t}s ($RB_STATUS) -- not evaluated
"
      continue
    fi
    out=$RB_OUT
    [ -n "$out" ] || continue
    # One document per line, because the merge below splits on newlines. lint-after-edit.sh
    # emits its block through a bare `jq -n`, which pretty-prints across lines, and each
    # fragment then failed to parse and became plain context: a lint block on a Bash write
    # reached the model as advisory text, not as a block. Plain text fails `jq -c` and
    # passes through unchanged.
    compact=$(printf '%s' "$out" | jq -c . 2>/dev/null) && out=$compact
    OUTPUTS="$OUTPUTS$out
"
  done
done

if [ -z "$OUTPUTS$NOTEVAL" ]; then exit 0; fi

# Merge. A hook may emit at most one JSON document, so four hooks' worth of output has to
# collapse into one: any `block` decision wins and its reasons are concatenated, otherwise
# every additionalContext and every line of plain text is joined into a single context
# string. The not-evaluated lines are appended to whichever one it is. Plain stdout is kept rather than dropped — auto-format.sh reports a missing
# formatter that way, and losing it would make the fanout quieter than a real edit.
# Piped rather than fed as a here-string: bash backs a here-string with a tempfile on many
# versions, which would bring back the dependency the variable above removed.
printf '%s' "$OUTPUTS" | jq -Rs --arg noteval "$NOTEVAL" '
  [ split("\n")[] | select(length > 0)
    | . as $line | (try ($line | fromjson) catch {plain: $line}) ] as $docs
  | ( [ $docs[] | select(.decision == "block") | .reason | select(. != null) ] ) as $blocks
  | ( [ $docs[]
        | if .hookSpecificOutput.additionalContext then .hookSpecificOutput.additionalContext
          elif .plain then .plain
          else empty end ] ) as $ctx
  | ( [ $noteval | split("\n")[] | select(length > 0) ] ) as $ne
  | if ($blocks | length) > 0 then
      { decision: "block", reason: (($blocks + $ne) | join("\n\n")) }
    elif (($ctx + $ne) | length) > 0 then
      { hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: (($ctx + $ne) | join("\n")) } }
    else empty end
'

exit 0
