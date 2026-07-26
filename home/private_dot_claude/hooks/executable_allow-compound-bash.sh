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

SETTINGS_FILES=("$HOME/.claude/settings.json")
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  for f in "$CLAUDE_PROJECT_DIR/.claude/settings.json" "$CLAUDE_PROJECT_DIR/.claude/settings.local.json"; do
    [ -f "$f" ] && SETTINGS_FILES+=("$f")
  done
fi
INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

# Only act on compound commands (chains or pipes)
if [[ "$COMMAND" != *"&&"* && "$COMMAND" != *";"* && "$COMMAND" != *"|"* ]]; then
  exit 0
fi

# Extract Bash(...) entries from a permissions list and normalize to plain
# command prefixes by stripping Bash(...) wrapper and trailing :*, *, etc.
extract_bash_prefixes() {
  local field="$1" s
  for s in "${SETTINGS_FILES[@]}"; do
    jq -r --arg f "$field" \
      '.permissions[$f][]? | select(startswith("Bash(")) | ltrimstr("Bash(") | rtrimstr(")") | gsub(":\\*$";"") | gsub(" \\*$";"") | gsub("\\*$";"")' \
      "$s" 2>/dev/null
  done
}

ALLOW=()
while IFS= read -r line; do [[ -n "$line" ]] && ALLOW+=("$line"); done < <(extract_bash_prefixes "allow")

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
done < <(extract_bash_prefixes "deny")
ASK=(); ASK_GLOB=()
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  case $line in *'*'*) ASK_GLOB+=("$line") ;; *) ASK+=("$line") ;; esac
done < <(extract_bash_prefixes "ask")

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
if matches_glob "$COMMAND" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"} \
  || matches_glob "$COMMAND" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
  exit 0
fi

SPLIT=$(split_outside_quotes "$COMMAND") || exit 0
PARTS=()
while IFS= read -r line; do [[ -n "$line" ]] && PARTS+=("$line"); done <<< "$SPLIT"

for part in "${PARTS[@]}"; do
  part=$(trim "$part")
  [ -z "$part" ] && continue

  # Redirection turns an allow-listed reader into a writer (`jq . f.json > ~/.bashrc`),
  # and matches_any only ever looks at the command prefix. Quote-aware splitting brought
  # segments like that within reach for the first time, so bail rather than guess.
  # /dev/null and fd dups are the harmless cases and are everywhere in diagnostics.
  redir=$(printf '%s' "$part" | sed -E 's@[0-9]*>>?[[:space:]]*/dev/null@@g; s@[0-9]*>&[0-9-]@@g')
  case $redir in
    *'>'*) exit 0 ;;
  esac

  # Deny or ask list → defer to normal permission handling
  if matches_any "$part" ${DENY[@]+"${DENY[@]}"} || matches_any "$part" ${ASK[@]+"${ASK[@]}"} \
    || matches_glob "$part" ${DENY_GLOB[@]+"${DENY_GLOB[@]}"} \
    || matches_glob "$part" ${ASK_GLOB[@]+"${ASK_GLOB[@]}"}; then
    exit 0
  fi

  # Not in allow list → defer
  if ! matches_any "$part" "${ALLOW[@]}"; then
    exit 0
  fi
done

printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
