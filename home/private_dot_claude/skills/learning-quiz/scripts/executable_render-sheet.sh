#!/bin/bash
# render-sheet.sh — the scheduled half of mechanism C: write the day's due cards
# as a self-contained HTML quiz sheet. Deterministic on purpose. The first cut
# asked the headless model to branch on an env var and render the sheet itself;
# it ignored the var, ran the interactive half, and printed a question into a log
# with nobody reading it. A launchd job has no one to answer, so the half that
# runs there gets no model at all — the sheet is a list of due cards with the
# answers folded away, which is pure formatting.
#
# Invoked by com.daniel.claude.learning-quiz.plist through run-skill.sh's
# documented --cmd passthrough, so it inherits that runner's log, 20-minute
# timeout, per-day idempotency marker, and failure notification.
#
# Usage: render-sheet.sh [output.html]
# Default output: $HOME/.claude/artifacts/learning-quiz-<date>.html
#
# Portability: /bin/bash here is 3.2 and scripts do not get gnubin on PATH, so
# no bash-4 syntax and no GNU-only date flags. Date arithmetic and due selection
# live in cards.sh; this script only formats what that prints.

set -u

HERE=${BASH_SOURCE[0]%/*}
# Deployed name first, source-tree name second: chezmoi strips the
# `executable_` prefix on apply, and the sibling test runs in both trees.
CARDS_SH="$HERE/cards.sh"; [ -x "$CARDS_SH" ] || CARDS_SH="$HERE/executable_cards.sh"
[ -x "$CARDS_SH" ] || { printf 'render-sheet.sh: missing %s\n' "$CARDS_SH" >&2; exit 1; }

CARDS_DIR="${CLAUDE_LEARN_CARDS_DIR:-${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}/Learning/cards}"
TODAY="${CLAUDE_LEARN_TODAY:-$(date +%F)}"
OUT="${1:-$HOME/.claude/artifacts/learning-quiz-$TODAY.html}"
mkdir -p "${OUT%/*}" 2>/dev/null || true
TAB=$(printf '\t')

esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
escs() { printf '%s' "$1" | esc; }

# fm <card> <key> — one frontmatter value, from the leading block only.
fm() {
  awk -v key="$2" '
    NR == 1 && $0 != "---" { exit }
    NR == 1 { next }
    $0 == "---" { exit }
    index($0, key ":") == 1 { sub(/^[^:]*: */, ""); print; exit }' "$1" 2>/dev/null
}

# body <card> — the card's prose, frontmatter stripped and the H1 dropped, as
# escaped HTML paragraphs. The card's own bold labels stay as written; Markdown
# is not rendered, because a card is short enough to read as plain prose.
body() {
  awk 'NR == 1 && $0 == "---" { fmb = 1; next }
       fmb && $0 == "---" { fmb = 0; next }
       fmb { next }
       index($0, "# ") == 1 { next }
       { print }' "$1" | esc | awk '
    { if ($0 ~ /^[ \t]*$/) { if (open) { print "</p>"; open = 0 } }
      else { if (!open) { printf "%s", "<p>"; open = 1 } else printf " "; printf "%s", $0 } }
    END { if (open) print "</p>" }'
}

DUE=$("$CARDS_SH" due "$TODAY")
COUNT=0
[ -n "$DUE" ] && COUNT=$(printf '%s\n' "$DUE" | wc -l | tr -d ' ')

render() {
  cat <<'HEAD'
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Learning quiz</title>
<style>
  :root { --bg:#fbfaf8; --fg:#1d1c1a; --dim:#6b6862; --line:#e0ddd6; --card:#ffffff; --accent:#7a4b2a; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#17161a; --fg:#e7e4de; --dim:#9b968d; --line:#2f2d33; --card:#1e1d22; --accent:#d9a577; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2.5rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:16px/1.6 ui-serif, Georgia, "Times New Roman", serif; }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  .meta { color:var(--dim); font:400 .8rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          margin:0 0 2rem; }
  article { background:var(--card); border:1px solid var(--line); border-radius:8px;
            padding:1.1rem 1.25rem; margin:0 0 1rem; }
  h2 { font-size:1.05rem; margin:0 0 .5rem; line-height:1.35; }
  .summary { margin:0; }
  .tag { display:inline-block; color:var(--dim);
         font:400 .72rem/1 ui-monospace, SFMono-Regular, Menlo, monospace;
         border:1px solid var(--line); border-radius:999px; padding:.28rem .55rem;
         margin:0 .35rem .35rem 0; }
  details { margin:.9rem 0 0; border-top:1px solid var(--line); padding-top:.7rem; }
  summary { cursor:pointer; color:var(--accent); font:600 .85rem/1.4 ui-sans-serif, system-ui, sans-serif; }
  details p { margin:.7rem 0 0; }
  footer { color:var(--dim); font:400 .82rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
           border-top:1px solid var(--line); margin-top:2rem; padding-top:1rem; }
  code { font:400 .88em/1 ui-monospace, SFMono-Regular, Menlo, monospace;
         background:var(--bg); border:1px solid var(--line); border-radius:3px; padding:.05em .3em; }
</style>
</head><body><main>
HEAD

  printf '<h1>Learning quiz</h1>\n'
  if [ "$COUNT" -eq 0 ]; then
    printf '<p class="meta">%s &middot; nothing due</p>\n' "$(escs "$TODAY")"
    NEXT=$(awk 'index($0, "next_review:") == 1 { sub(/^[^:]*: */, ""); print }' \
             "$CARDS_DIR"/*.md 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort | head -1)
    if [ -n "$NEXT" ]; then
      printf '<article><p class="summary">No cards are due today. The next one comes due on %s.</p></article>\n' "$(escs "$NEXT")"
    else
      printf '<article><p class="summary">No cards are due today, and none are scheduled — <code>learning-digest</code> has not written any yet.</p></article>\n'
    fi
  else
    printf '<p class="meta">%s &middot; %s card(s) due, most overdue first</p>\n' "$(escs "$TODAY")" "$COUNT"
    # Ascending next_review, so the most overdue card is reviewed first.
    printf '%s\n' "$DUE" | sort -t "$TAB" -k2,2 | while IFS="$TAB" read -r path nr iv title; do
      [ -f "$path" ] || continue
      slug=${path##*/}; slug=${slug%.md}
      printf '<article>\n<h2>%s</h2>\n<p class="summary">%s</p>\n' \
        "$(escs "$title")" "$(escs "$(fm "$path" summary)")"
      printf '<p><span class="tag">due %s</span><span class="tag">interval %sd</span><span class="tag">%s</span></p>\n' \
        "$(escs "$nr")" "$(escs "$iv")" "$(escs "$slug")"
      printf '<details><summary>Show the card</summary>\n'
      body "$path"
      printf '</details>\n</article>\n'
    done
  fi

  printf '<footer>Run <code>/quiz</code> to be asked these one at a time and graded — that is the only path that advances <code>interval</code> and <code>next_review</code>. Reading this sheet changes nothing.</footer>\n'
  printf '</main></body></html>\n'
}

# Write through a temp file so a failed render leaves yesterday's sheet intact
# rather than a truncated one.
TMP=$(mktemp "${TMPDIR:-/tmp}/quizsheet.XXXXXX") || exit 1
if render > "$TMP" && [ -s "$TMP" ]; then
  cat "$TMP" > "$OUT"
  rm -f -- "$TMP"
else
  rm -f -- "$TMP"
  printf 'render-sheet.sh: produced nothing\n' >&2
  exit 1
fi

printf 'learning-quiz: %s due, sheet at %s\n' "$COUNT" "$OUT"
