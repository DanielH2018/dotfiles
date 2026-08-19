---
name: learning-digest
description: Drain the SessionEnd learning queue — read each queued transcript and append one debrief block to the vault's Learning/session-log.md plus up to three concept cards. Runs headless from the SessionEnd hook via run-skill.sh; invoke as /learning-digest to drain by hand.
disable-model-invocation: true
---

# learning-digest

Mechanism A of `~/.claude/specs/learning-loop_2026-08-19.md`. The `SessionEnd`
hook cannot ask the live model anything — its output never reaches Claude — so
it only enqueues the transcript path. This skill is the half that writes.

You are running headless and unattended. Nobody answers a question. If a step
cannot be completed, log why and move to the next queue entry.

## STEP 0 — Resolve paths

- `$VAULT` = `${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}`. If it does not
  exist, print `no vault — nothing to do` and stop.
- `$QUEUE` = `$HOME/.claude/logs/learning-queue`.

## STEP 1 — Claim the queue

Rename the pending file so a session ending mid-drain lands in the next drain
instead of being lost or double-processed:

```
cd "$QUEUE" 2>/dev/null && [ -s pending.tsv ] && mv pending.tsv "claim-$$.tsv"
```

If there is no `pending.tsv`, also look for a `claim-*.tsv` left behind by an
earlier run that died; adopt the oldest one. If there is nothing at all, print
`queue empty` and stop — do not write to the vault.

Each line is TSV: `ended_at`, `session_id`, `cwd`, `transcript_path`.

## STEP 2 — Read each transcript, bounded

Transcripts are JSONL and can be tens of megabytes. Never `cat` one.

For each queue line, extract a bounded digest of the session. Prefer one pass
with `jq`, capped, and cut long lines:

```
jq -r 'select(.type=="user" or .type=="assistant")
       | .message.content
       | if type=="array" then (map(select(.type=="text").text) | join(" ")) else . end
       | select(. != null and . != "")' "$TRANSCRIPT" 2>/dev/null \
  | cut -c1-400 | head -200
```

Also read the last ~40 lines the same way, so the end of the session (what
actually landed) is represented, not only its opening.

If the transcript is missing or unparseable, skip that line and note it.

## STEP 3 — Write one session-log block

Prepend the block directly under the `---` separator in
`$VAULT/Learning/session-log.md`, above the previous top block — newest first,
matching the `log.md` idiom. Do not touch older blocks.

```markdown
## YYYY-MM-DD — <short title of what the session was about>

- **What changed.** The concrete outcome — files, mechanisms, decisions. Name
  the actor and cite `file:line` where it helps.
- **Why.** The constraint or finding that forced that shape.
- **Takeaway.** The one thing Daniel would need to know to have done it himself.

See [[card-slug]], [[other-card-slug]].
```

Then set the file's `updated:` frontmatter field to today.

**Idempotency — check before you prepend.** Search `session-log.md` for a block
whose `source_session` title matches the one you are about to write, or for the
same `session_id` recorded for the same date. If it is already there, skip the
block and the cards for that queue line and count it as done. A queue entry can
legitimately arrive twice: two `SessionEnd` fires for one session, or a drain
whose vault writes succeeded but whose claim file survived and was adopted by
the next run.

Rules for the block:

- Three bullets. This is a debrief, not a transcript summary.
- Record what was **decided and why**, not the sequence of tool calls.
- If the session reached no durable conclusion, write the block anyway and say
  so in one line. A short honest block beats an invented one.
- Never invent a fact the transcript does not support. This file is read months
  later as if it were true.

## STEP 4 — Write up to three cards

Only for concepts that generalise beyond the session. Zero cards is a valid
outcome and the common one; three is the hard cap.

Write each to `$VAULT/Learning/cards/<slug>.md`, slug in lower-kebab-case:

```markdown
---
title: <the concept, as a claim>
summary: <one sentence — this is what the quiz shows first>
tags: [learning-card, <topic>]
created: YYYY-MM-DD
updated: YYYY-MM-DD
interval: 1
next_review: <tomorrow>
source_session: YYYY-MM-DD — <same title as the log block>
---

# <title>

**The concept.** ...

**Why it matters.** ...

**The catch.** <the part that is easy to get wrong — omit if there isn't one>

Source: [[session-log]].
```

If the slug already exists, update that card instead of creating a near-duplicate:
refresh `summary`/body, set `updated` to today, and leave `interval` and
`next_review` alone — the review schedule belongs to `/quiz`, not to this skill.

## STEP 5 — Register the cards

Two registrations, both required or `/lint` reports the cards as unreachable:

1. Add a row per new card to the table in `$VAULT/Learning/cards/_Index.md` and
   set that file's `updated` to today.
2. Make sure the session-log block links every card it produced, and every card
   links back with `Source: [[session-log]]`. A card with no inbound link is an
   orphan in the next lint run.

Do **not** add cards to `$VAULT/index.md` — `Learning/cards/` is excluded from
the index sweep in `.claude/wiki-context.local.md` precisely so the index does
not grow by one line per card.

## STEP 6 — Retire the claim

Delete `$QUEUE/claim-$$.tsv` only after the vault writes succeeded. On failure,
leave it in place so the next drain retries, and print the reason.

Print a one-line status and nothing else: `learning-digest: N sessions, M cards`.

## Out of scope

- Committing. Daniel commits the vault himself.
- Advancing `interval` / `next_review` — that is the quiz's job.
- Touching `log.md`. The learning loop writes to `Learning/`, not to the vault's
  operational audit trail.
