---
description: "Arbiter classification logic for review-and-fix. Not invoked directly."
disable-model-invocation: true
---

## Arbiter Classification

For each finding from the review phase, perform these steps:

### Step 1: Verify the finding

Read the actual code at the cited file:line. Confirm the finding is accurate against the current code. If the code has already been fixed or the finding references stale line numbers, classify as `SKIP`.

### Step 2: Classify

Assign exactly one classification:

**`SKIP`** — The finding is:
- A false positive (code is correct)
- A stylistic nit (formatting, naming preferences)
- A suggestion that adds unnecessary complexity
- Already fixed or stale

**`HAIKU-FIX`** — The fix is mechanical and single-line:
- Missing null/undefined check
- Typo in string, variable name, or comment
- Simple rename
- Adding a missing return statement
- Obvious one-liner with no behavioral ambiguity

**`SONNET-FIX`** — The fix requires reasoning:
- Multi-line logic change
- Cross-file edit (changing an interface and its callers)
- Guard clause that requires understanding control flow
- Error handling that requires understanding failure modes
- Any fix where the "right" answer isn't immediately obvious

When in doubt between HAIKU-FIX and SONNET-FIX, choose SONNET-FIX.

### Step 3: Apply autonomy mode

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
  ```
- Wait for user approval before proceeding
- User can modify classifications or skip additional findings

### Step 4: Output

Produce a structured list of approved findings for the fix phase:

```
APPROVED FIXES:
- { file: "src/a.ts", line: 42, type: "HAIKU-FIX", desc: "Missing null check", reasoning: "..." }
- { file: "src/b.ts", line: 15, type: "SONNET-FIX", desc: "Race in token refresh", reasoning: "..." }

SKIPPED:
- { file: "src/c.ts", line: 99, reason: "Stylistic preference, not a bug" }
```
