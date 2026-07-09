---
name: distill-scan
description: Use after a security-sweep or code-review to distill its findings into cheap, reusable detection patterns for a repo's pre-commit scan — pay for the model reasoning once, re-scan on CPU forever. Derives, validates, and (on approval) writes regexes to the repo's .claude/scan-patterns.json. Triggers on "turn these findings into a scan rule", "make this a pre-commit check", "distill this security review".
---

# distill-scan

A frontier-model security review is expensive and one-shot. Distill its findings
into a deterministic ruleset that a pre-commit hook re-runs for free. This skill
derives and validates the patterns; where they land depends on how the repo's
pre-commit already scans — an external pattern file loaded by a hook, or an inline
pattern list in a bash hook. Inspect the repo's hook first — see "Where the
patterns go" below.

## When to use

Reach for this after a security-sweep or code-review finishes, or whenever
the user says "turn these findings into a scan rule" or "make this a
pre-commit check." Don't invoke it before you have concrete findings — it
distills existing findings, it doesn't hunt for new ones. Use it only when
a finding generalizes to a recurring pattern; skip one-off findings that
won't recur.

## Input

Findings from `/security-sweep`, `/code-review`, or a described vulnerability
class (e.g. "hardcoded internal hostnames", "raw SQL string concatenation",
"a private key committed as base64"). Work from the **pattern**, not the one
specific instance.

## Procedure

1. Derive a line-oriented regex for each finding. It must match the class
   on a single line (the loader tests line by line).
2. Validate every candidate before proposing it; never present one that
   fails these checks:
   - compiles under `new RegExp(src)`;
   - passes a safe-regex pre-filter — no nested quantifier shapes (`(a+)+`,
     `(.*)*`, `(ab+)*`), no absurd bounded repeats (`{1000,}`) — the classic
     ReDoS shapes;
   - matches a positive sample, does not match a benign sample, and returns
     fast on a long input. Run a timed check like:

     ```bash
     node -e 'const re=new RegExp(process.argv[1]); const t=Date.now();
     re.test("x".repeat(50000));
     if (Date.now()-t>100) throw new Error("slow regex")' "<pattern>"
     ```
3. Present the surviving candidates as entries in this shape, with their
   positive/benign samples, then wait for approval — do not skip this step
   even if every candidate passed validation:

   ```json
   { "name": "hardcoded-internal-host", "re": "internal\\.example\\.com", "severity": "high" }
   ```
4. Write only approved entries into the repo's pre-commit scan (see below).
   Never write an unvalidated or unsafe pattern, and never write without
   approval — that's the user's call, not yours to make unilaterally.

## Where the patterns go

Read the repo's pre-commit hook first, then integrate to match how it scans —
confirm the target with the user before writing:

- **External pattern file** (a hook that loads a JSON array): append validated
  entries as `{ "name": string, "re": string, "severity"?: string }`, where `re`
  is a JavaScript regex **source string** (no slashes, no flags). Create the file
  if the hook expects one but it's absent.
- **Inline pattern list** (a self-contained bash hook — e.g. this vault's
  `.githooks/pre-commit`, which greps added lines against a `patterns='a|b|c'`
  alternation): add each validated regex as a new alternation branch there.

Either way patterns are line-oriented — keep them anchored/bounded so a
pathological input can't hang a commit, and don't duplicate a built-in the hook
already covers.

Report-only until the user approves the pattern set. See also the
security-sweep and code-review skills, which produce the findings this
skill consumes — delegate to them first if there's nothing to distill yet.
