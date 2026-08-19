#!/bin/bash
# test_cards.sh — fixture tests for cards.sh. Builds a throwaway card directory,
# so it never reads or writes the real vault. Run: ./executable_test_cards.sh

set -u

HERE=${BASH_SOURCE[0]%/*}
# Deployed name first, source-tree name second: chezmoi strips the
# `executable_` prefix on apply, and this test must run in both trees.
CARDS="$HERE/cards.sh";        [ -x "$CARDS" ]  || CARDS="$HERE/executable_cards.sh"
RENDER="$HERE/render-sheet.sh"; [ -x "$RENDER" ] || RENDER="$HERE/executable_render-sheet.sh"
[ -x "$CARDS" ]  || { echo "missing cards.sh"; exit 1; }
[ -x "$RENDER" ] || { echo "missing render-sheet.sh"; exit 1; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/test_cards.XXXXXX") || exit 1
# Tear the fixture down with find -delete rather than a recursive remove: the
# name guard makes an unset or clobbered $WORK a no-op instead of a wide delete.
cleanup() {
  case "${WORK:-}" in
    */test_cards.??????) find "$WORK" -mindepth 1 -delete 2>/dev/null; rmdir "$WORK" 2>/dev/null ;;
  esac
}
trap cleanup EXIT
export CLAUDE_LEARN_CARDS_DIR="$WORK/cards"
export CLAUDE_LEARN_TODAY=2026-08-19
mkdir -p "$CLAUDE_LEARN_CARDS_DIR"

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n     want: %s\n     got:  %s\n' "$1" "$2" "$3"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3" "$2"; fi; }

card() { # card <slug> <interval> <next_review>
  cat > "$CLAUDE_LEARN_CARDS_DIR/$1.md" <<EOF
---
title: concept $1
summary: one sentence about $1
tags: [learning-card, test]
created: 2026-08-01
updated: 2026-08-01
interval: $2
next_review: $3
source_session: 2026-08-01 — fixture
---

# concept $1

**The concept.** body of $1
EOF
}

write_index() {
  cat > "$CLAUDE_LEARN_CARDS_DIR/_Index.md" <<'IDX'
---
title: Learning Cards
summary: Index of durable concept cards
tags: [meta, learning]
created: 2026-08-01
updated: 2026-08-01
---

# Learning Cards

## Cards

| Card | Next review |
|---|---|
| [[overdue]] — a card past its date | 2026-08-10 |
| [[due-today]] — a card due today | 2026-08-19 |
| [[future]] — a card not yet due | 2026-09-01 |
IDX
}

get() { awk -v k="$2" 'index($0, k ":") == 1 { sub(/^[^:]*: */, ""); print; exit }' "$1"; }

# ── ladder (pure) ──────────────────────────────────────────────────────────
is 'ladder 1 hit -> 3'      "$("$CARDS" ladder 1 hit)"   3
is 'ladder 3 hit -> 7'      "$("$CARDS" ladder 3 hit)"   7
is 'ladder 7 hit -> 21'     "$("$CARDS" ladder 7 hit)"   21
is 'ladder 21 hit -> 60'    "$("$CARDS" ladder 21 hit)"  60
is 'ladder 60 hit stays 60' "$("$CARDS" ladder 60 hit)"  60
is 'ladder 60 miss -> 1'    "$("$CARDS" ladder 60 miss)" 1
is 'ladder 1 miss -> 1'     "$("$CARDS" ladder 1 miss)"  1
is 'off-ladder 10 snaps up' "$("$CARDS" ladder 10 hit)"  21
is 'garbage interval -> 1'  "$("$CARDS" ladder xx hit)"  1
is 'zero interval -> 1'     "$("$CARDS" ladder 0 hit)"   1

# ── due selection ──────────────────────────────────────────────────────────
card overdue   1  2026-08-10
card due-today 3  2026-08-19
card future    7  2026-09-01
card broken    1  not-a-date
: > "$CLAUDE_LEARN_CARDS_DIR/empty.md"
write_index

got=$("$CARDS" due | cut -f1 | sed "s|.*/||" | sort | tr '\n' ' ')
is 'due lists overdue + due-today only' "$got" 'due-today.md overdue.md '

got=$("$CARDS" due 2026-09-02 | wc -l | tr -d ' ')
is 'a later reference date widens the set' "$got" 3

got=$("$CARDS" due 2026-09-02 | cut -f1 | sed "s|.*/||" | sort | tr '\n' ' ')
is 'a bad date and a frontmatterless file are both skipped' "$got" 'due-today.md future.md overdue.md '

got=$("$CARDS" due | awk -F'\t' '$1 ~ /overdue/ { print $2 "/" $3 "/" $4 }')
is 'due row carries next_review, interval, title' "$got" '2026-08-10/1/concept overdue'

got=$("$CARDS" due | grep -c '_Index' || true)
is '_Index.md is not treated as a card' "$got" 0

# ── advance: hit ───────────────────────────────────────────────────────────
"$CARDS" advance "$CLAUDE_LEARN_CARDS_DIR/overdue.md" hit >/dev/null
is 'hit advances interval 1 -> 3' "$(get "$CLAUDE_LEARN_CARDS_DIR/overdue.md" interval)"    3
is 'hit sets next_review +3 days' "$(get "$CLAUDE_LEARN_CARDS_DIR/overdue.md" next_review)" 2026-08-22
is 'hit stamps updated'           "$(get "$CLAUDE_LEARN_CARDS_DIR/overdue.md" updated)"     2026-08-19
is 'body survives the rewrite'    "$(grep -c 'body of overdue' "$CLAUDE_LEARN_CARDS_DIR/overdue.md")" 1
is 'title survives the rewrite'   "$(get "$CLAUDE_LEARN_CARDS_DIR/overdue.md" title)" 'concept overdue'

got=$(grep '\[\[overdue\]\]' "$CLAUDE_LEARN_CARDS_DIR/_Index.md")
is 'index row shows the new date' "$got" '| [[overdue]] — a card past its date | 2026-08-22 |'
is 'index updated is stamped'     "$(get "$CLAUDE_LEARN_CARDS_DIR/_Index.md" updated)" 2026-08-19
got=$(grep '\[\[future\]\]' "$CLAUDE_LEARN_CARDS_DIR/_Index.md")
is 'other index rows untouched'   "$got" '| [[future]] — a card not yet due | 2026-09-01 |'

# ── advance: miss ──────────────────────────────────────────────────────────
"$CARDS" advance "$CLAUDE_LEARN_CARDS_DIR/future.md" miss >/dev/null
is 'miss resets interval to 1'    "$(get "$CLAUDE_LEARN_CARDS_DIR/future.md" interval)"    1
is 'miss sets next_review +1 day' "$(get "$CLAUDE_LEARN_CARDS_DIR/future.md" next_review)" 2026-08-20

# ── advance: refusals ──────────────────────────────────────────────────────
"$CARDS" advance "$CLAUDE_LEARN_CARDS_DIR/overdue.md" maybe >/dev/null 2>&1
is 'a bad grade is rejected' "$?" 1
"$CARDS" advance "$CLAUDE_LEARN_CARDS_DIR/nope.md" hit >/dev/null 2>&1
is 'a missing card is rejected' "$?" 1
"$CARDS" bogus >/dev/null 2>&1
is 'an unknown subcommand is rejected' "$?" 1

# ── advance: a card with no index row ──────────────────────────────────────
card orphan 1 2026-08-10
"$CARDS" advance "$CLAUDE_LEARN_CARDS_DIR/orphan.md" hit >/dev/null
is 'a card missing from the index still advances' "$(get "$CLAUDE_LEARN_CARDS_DIR/orphan.md" interval)" 3


# ── render-sheet.sh: the scheduled half ────────────────────────────────────
# A fresh card directory, so these assertions do not depend on what the advance
# section above left behind.
export CLAUDE_LEARN_CARDS_DIR="$WORK/sheet-cards"
mkdir -p "$CLAUDE_LEARN_CARDS_DIR"
card overdue   1 2026-08-10
card due-today 3 2026-08-19
card future    7 2026-09-01
write_index
SHEET="$WORK/sheet.html"

out=$("$RENDER" "$SHEET")
is 'render reports the due count'      "$out" "learning-quiz: 2 due, sheet at $SHEET"
is 'one article per due card'          "$(grep -c '<article>' "$SHEET")" 2
is 'the sheet is a complete document'  "$(grep -c '</html>' "$SHEET")" 1
is 'a card title is the question'      "$(grep -c '<h2>concept overdue</h2>' "$SHEET")" 1
is 'each card body is folded away'     "$(grep -c '<details>' "$SHEET")" 2
is 'the body rides inside the details' "$(grep -c 'body of overdue' "$SHEET")" 1
is 'a not-yet-due card is left out'    "$(grep -c 'concept future' "$SHEET")" 0
is 'the footer names /quiz'            "$(grep -c 'quiz</code> to be asked' "$SHEET")" 1
is 'the due date is shown per card'    "$(grep -c 'due 2026-08-10' "$SHEET")" 1

# Most overdue first: the earliest next_review appears before the later one.
is 'the most overdue card comes first' \
   "$(grep -o '<h2>concept [a-z-]*</h2>' "$SHEET" | head -1)" '<h2>concept overdue</h2>'

# Nothing due: still a sheet, naming the next date rather than failing.
out=$(CLAUDE_LEARN_TODAY=2026-08-01 "$RENDER" "$SHEET")
is 'an empty day still reports'        "$out" "learning-quiz: 0 due, sheet at $SHEET"
is 'an empty day says nothing is due'  "$(grep -c 'nothing due' "$SHEET")" 1
is 'an empty day names the next date'  "$(grep -c 'comes due on 2026-08-10' "$SHEET")" 1

# HTML metacharacters in card text must not escape into markup.
card evil 1 2026-08-10
awk '{ if (index($0, "title:") == 1) print "title: a & b <script>x</script>"; else print }' \
  "$CLAUDE_LEARN_CARDS_DIR/evil.md" > "$WORK/e.md"
cat "$WORK/e.md" > "$CLAUDE_LEARN_CARDS_DIR/evil.md"
"$RENDER" "$SHEET" >/dev/null
is 'card text is HTML-escaped'  "$(grep -c '&lt;script&gt;' "$SHEET")" 1
is 'no raw script tag gets out' "$(grep -c '<script>' "$SHEET")" 0
is 'an ampersand is escaped'    "$(grep -c 'a &amp; b' "$SHEET")" 1

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
