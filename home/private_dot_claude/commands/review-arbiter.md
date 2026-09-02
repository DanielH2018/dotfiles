---
description: "Arbiter classification logic for review-and-fix. Not invoked directly."
disable-model-invocation: true
---

## Arbiter Classification

### Step 1: Classify

Assign exactly one classification:

**`SKIP`** — false positive, stylistic nit, unnecessary complexity, or already fixed/stale. `SKIP` feeds the do-not-re-raise list, so it means the finding must never come back.

**`DEFER`** — real and in scope for the repo, but out of scope for this loop: a design change, a different service, or a fix that needs an operator decision. A deferred finding is filed, never suppressed. In the server repo, file it with `uv run python scripts/dev/findings.py open --title "<finding>" --body-file <f> --severity <high|medium|low> --kind gap --file <file:line> --source review-and-fix`, and write the issue number into the ledger row. Elsewhere, `gh issue create` directly.

**`HAIKU-FIX`** — the fix is mechanical and single-line, with no behavioral ambiguity.

**`SONNET-FIX`** — the fix requires reasoning: multi-line logic, a cross-file edit, or anything where the "right" answer isn't immediately obvious.

When in doubt between HAIKU-FIX and SONNET-FIX, choose SONNET-FIX.

### Step 2: Apply autonomy mode

The mode is passed as an argument from `/review-loop`.

**`auto` mode:**
- Proceed with all non-SKIP findings immediately

**`default` mode:**
- Auto-proceed on findings that are clearly bugs or security issues
- For subjective or architectural findings (e.g., "this pattern could be cleaner", "consider extracting this"), present them to the user and ask whether to fix or skip
- Format the question as a numbered list so the user can respond quickly (e.g., "fix 1,3, skip 2")

**`confirm` mode:**
- Present the full classification table:
  ```
  | # | File:Line | Classification | Description |
  |---|-----------|---------------|-------------|
  | 1 | src/a.ts:42 | HAIKU-FIX | Missing null check |
  | 2 | src/b.ts:15 | SONNET-FIX | Race condition in refresh |
  | 3 | src/c.ts:99 | SKIP | Stylistic preference |
  | 4 | src/d.ts:210 | DEFER | Retry policy belongs in the scheduler, not here |
  ```
- Wait for user approval before proceeding
- User can modify classifications or skip additional findings

### Step 3: Output

Produce two lists — approved fixes and skipped findings — each entry carrying file, line, classification, description, and reasoning.
