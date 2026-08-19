#!/bin/bash
# cards.sh — the deterministic half of the learning-quiz skill (mechanism C of
# ~/.claude/specs/learning-loop_2026-08-19.md). Selecting due cards and advancing
# the SM-2-lite ladder are mechanical, so they live in shell where they can be
# tested; the questioning and the grading judgement stay with the model.
#
# Usage:
#   cards.sh due [YYYY-MM-DD]              list cards whose next_review <= date
#   cards.sh advance <card.md> hit|miss    advance the ladder, rewrite the card
#   cards.sh ladder <interval> hit|miss    print the next interval (pure, for tests)
#
# `due` prints one TSV row per due card: path, next_review, interval, title.
#
# Card directory: $CLAUDE_LEARN_CARDS_DIR, else
# ${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}/Learning/cards. The env override
# exists so the test fixture never touches the real vault.
#
# Portability: this runs under /bin/bash, which is 3.2 on macOS, and scripts do
# not get gnubin on PATH — so no bash-4 syntax and no GNU-only `date -d`. Every
# rewrite goes through mktemp + mv rather than `sed -i`, because a stray .bak in
# Learning/cards/ is both diff noise and a file the vault lint sweeps.

set -u

CARDS_DIR="${CLAUDE_LEARN_CARDS_DIR:-${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}/Learning/cards}"

die() { printf 'cards.sh: %s\n' "$1" >&2; exit 1; }

# today [—] — the current date, overridable so tests are not time-dependent.
today() { printf '%s\n' "${CLAUDE_LEARN_TODAY:-$(date +%F)}"; }

# date_plus <days> — a date N days from today. BSD date takes -v, GNU date takes
# -d, and which one is on PATH depends on the caller's shell; try both.
date_plus() {
  local base
  base=$(today)
  date -j -f %F "$base" -v+"$1"d +%F 2>/dev/null && return 0
  date -d "$base + $1 days" +%F 2>/dev/null && return 0
  die "no usable date(1): neither BSD -v nor GNU -d worked"
}

# fm <file> <key> — the value of a frontmatter key, from the leading block only.
fm() {
  awk -v key="$2" '
    NR == 1 && $0 != "---" { exit }
    NR == 1 { next }
    $0 == "---" { exit }
    index($0, key ":") == 1 {
      sub(/^[^:]*: */, ""); print; exit
    }
  ' "$1" 2>/dev/null
}

# ladder <interval> hit|miss — SM-2-lite: 1 / 3 / 7 / 21 / 60, a miss resets to 1.
# An off-ladder interval (hand-edited to 10, say) snaps up to the next rung
# rather than being rejected; 60 is the top and stays there.
ladder() {
  local cur="$1" grade="$2"
  case "$cur" in '' | *[!0-9]*) cur=0 ;; esac
  if [ "$grade" = miss ]; then printf '1\n'; return 0; fi
  for rung in 1 3 7 21 60; do
    if [ "$cur" -lt "$rung" ]; then printf '%s\n' "$rung"; return 0; fi
  done
  printf '60\n'
}

# due [date] — cards whose next_review is on or before `date`. The comparison is
# a lexicographic sort of two YYYY-MM-DD strings, which is a correct date compare
# for that format and needs no date parsing.
cmd_due() {
  local ref card nr iv title first
  ref="${1:-$(today)}"
  [ -d "$CARDS_DIR" ] || return 0
  for card in "$CARDS_DIR"/*.md; do
    [ -f "$card" ] || continue
    case "${card##*/}" in _*) continue ;; esac
    nr=$(fm "$card" next_review)
    case "$nr" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) continue ;; esac
    first=$(printf '%s\n%s\n' "$nr" "$ref" | sort | head -1)
    [ "$first" = "$nr" ] || continue
    iv=$(fm "$card" interval)
    case "$iv" in '' | *[!0-9]*) iv=1 ;; esac
    title=$(fm "$card" title)
    printf '%s\t%s\t%s\t%s\n' "$card" "$nr" "$iv" "$title"
  done
}

# rewrite <file> <awk-program> [awk-args...] — apply an awk program in place via
# mktemp + mv, preserving the original mode.
rewrite() {
  local file="$1" tmp; shift
  tmp=$(mktemp "${TMPDIR:-/tmp}/cards.XXXXXX") || die "mktemp failed"
  if awk "$@" "$file" > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    cat "$tmp" > "$file" && rm -f "$tmp" && return 0
  fi
  rm -f "$tmp"
  die "could not rewrite $file"
}

# advance <card.md> hit|miss — move the card to its next rung. Rewrites the
# card's interval / next_review / updated, then the matching row and `updated`
# in _Index.md, because a card advanced without its index row leaves the index
# table lying about when the card is next due.
cmd_advance() {
  local card="$1" grade="$2" cur new nr now slug index
  [ -f "$card" ] || die "no such card: $card"
  case "$grade" in hit | miss) ;; *) die "grade must be hit or miss, got '$grade'" ;; esac

  cur=$(fm "$card" interval)
  new=$(ladder "$cur" "$grade")
  nr=$(date_plus "$new") || exit 1
  now=$(today)

  rewrite "$card" -v iv="$new" -v nr="$nr" -v up="$now" '
    BEGIN { infm = 0 }
    NR == 1 && $0 == "---" { infm = 1; print; next }
    infm && $0 == "---" { infm = 0; print; next }
    infm && index($0, "interval:")    == 1 { print "interval: " iv; next }
    infm && index($0, "next_review:") == 1 { print "next_review: " nr; next }
    infm && index($0, "updated:")     == 1 { print "updated: " up; next }
    { print }
  '

  slug="${card##*/}"; slug="${slug%.md}"
  index="$CARDS_DIR/_Index.md"
  if [ -f "$index" ]; then
    # In the index table each card is one row ending in a "Next review" cell.
    # Replace that cell's contents on the row naming this slug, and nothing else.
    rewrite "$index" -v slug="[[$slug]]" -v nr="$nr" -v up="$now" '
      BEGIN { infm = 0; FS = "|"; OFS = "|" }
      NR == 1 && $0 == "---" { infm = 1; print; next }
      infm && $0 == "---" { infm = 0; print; next }
      infm && index($0, "updated:") == 1 { print "updated: " up; next }
      infm { print; next }
      index($0, slug) && NF >= 4 {
        last = NF; while (last > 1 && $last ~ /^[ \t]*$/) last--
        $last = " " nr " "
        print; next
      }
      { print }
    '
  fi

  printf '%s\t%s\t%s\t%s\n' "$card" "$grade" "$new" "$nr"
}

case "${1:-}" in
  due)     shift; cmd_due "${1:-}" ;;
  advance) shift; [ $# -eq 2 ] || die "usage: cards.sh advance <card.md> hit|miss"; cmd_advance "$1" "$2" ;;
  ladder)  shift; [ $# -eq 2 ] || die "usage: cards.sh ladder <interval> hit|miss"; ladder "$1" "$2" ;;
  *)       die "usage: cards.sh due [date] | advance <card.md> hit|miss | ladder <interval> hit|miss" ;;
esac
