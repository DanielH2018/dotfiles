---
name: learning-quiz
description: Spaced-repetition review of the vault's Learning cards. Invoked as /quiz it asks one question at a time and advances each card's SM-2-lite interval. Reads Learning/cards/, writes interval and next_review. The scheduled morning sheet is a separate deterministic script, not this skill.
disable-model-invocation: true
---

# learning-quiz

Mechanism C of `~/.claude/specs/learning-loop_2026-08-19.md`. Cards are written by
`learning-digest`; this skill is what makes them stick.

Spaced repetition needs a person, and a launchd run has none. The two halves are
therefore split by *mechanism*, not by a flag this skill reads:

| Half | What runs it | What it does |
|---|---|---|
| The morning sheet | `com.daniel.claude.learning-quiz` → `run-skill.sh learning-quiz headless --cmd .../render-sheet.sh` | Writes `~/.claude/artifacts/learning-quiz-<date>.html`. No model, so it cannot ask anybody anything. Advances nothing. |
| The quiz | Daniel types `/quiz` | This skill. One question at a time, graded, intervals advanced. |

An earlier design had this skill branch on an env var and render the sheet itself
when headless. It did not work: the headless run ignored the var, ran the
interactive half, and printed a question into a log nobody reads. Reading the
sheet is pure formatting, so the scheduled half gets no model. **This skill is
the interactive half only.** Never render the sheet from here.

## STEP 0 — Resolve paths

- `$VAULT` = `${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}`. If it does not
  exist, print `no vault — nothing to quiz` and stop.
- `$CARDS` = `$VAULT/Learning/cards`.
- `$SCRIPT` = `~/.claude/skills/learning-quiz/scripts/cards.sh`. If it is not
  executable, print that and stop — do not hand-roll the date arithmetic or the
  frontmatter rewrite. Both live in that script and are covered by its sibling
  `test_cards.sh`.

## STEP 1 — Open the set

The due list comes from one command. It prints one TSV row per due card — path,
`next_review`, `interval`, `title` — and nothing when nothing is due:

```
"$SCRIPT" due
```

A card is due when `next_review <= today`. Overdue cards are due, not skipped.

If the list is empty, print `nothing due today — next card is <date>` (the
earliest `next_review` across `$CARDS/*.md`) and stop.

Otherwise say how many cards are due and stop there. Do not list the questions —
the point is recall, and a preview of what is coming is a list of hints.

## STEP 2 — Ask one question at a time

Use the `grilling` primitive's one-question rule rather than reimplementing it:
ask, then wait for the answer before the next question. The turn ends on the
question mark; nothing rides along after it.

Two departures from `grilling`, because this is a quiz and not a design review:

- **Do not carry your own recommended answer.** Grilling proposes an answer so
  the user reacts to a proposal. Here the answer is the thing being tested, so
  proposing it defeats the exercise.
- **Ask about the card, not the plan.** Derive the question from the card's body —
  the concept, why it matters, and the catch. Aim at the catch: it is the part
  that is easy to get wrong and therefore the part worth reviewing.

One question per card, in ascending `next_review` order. Never show the card's
text before the answer.

## STEP 3 — Grade honestly, then advance

After each answer, grade it `hit` or `miss` and say which, in one line, naming
the part they missed if they missed one.

- `hit` — the answer carried the concept *and* the catch.
- `miss` — anything less: a partial answer, a right answer for the wrong reason,
  or "I don't know". A generous grade puts the card 60 days out and quietly
  removes it from the rotation, which is the failure this schedule exists to
  prevent.

Then advance the card, one call per card, immediately after grading it — so an
interrupted quiz keeps the cards it already got through:

```
"$SCRIPT" advance "<card path>" hit|miss
```

That single call moves the ladder (1 / 3 / 7 / 21 / 60 days, a miss resets to 1),
stamps `next_review` and `updated` on the card, and rewrites the card's row and
`updated` in `$CARDS/_Index.md`. Do not edit those fields by hand — the script is
the only writer, and the index row is the half that is easy to forget.

Show the card's full text after grading, so a miss is a chance to reread it.

## STEP 4 — Close

One closing line: cards reviewed, hits, misses, and the date the next card comes
due. If a miss revealed the card itself is wrong or muddled, say so and offer to
fix the card — do not fix it unprompted.

## Out of scope

- Committing. Daniel commits the vault himself.
- Writing new cards — that is `learning-digest`.
- Rendering the morning sheet — that is `scripts/render-sheet.sh`, run by launchd.
- Rewriting a card's body during a quiz. Offer; wait to be asked.
