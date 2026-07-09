---
name: distill-scan
description: Use after a security-sweep or code-review to distill its findings into cheap, reusable detection patterns for a repo's pre-commit scan — pay for the model reasoning once, re-scan on CPU forever. Derives, validates, and (on approval) writes regexes to the repo's .claude/scan-patterns.json. Triggers on "turn these findings into a scan rule", "make this a pre-commit check", "distill this security review".
---

# distill-scan

A frontier-model security review is expensive and one-shot. Distill its findings
into a deterministic ruleset that a pre-commit hook re-runs for free. This skill
produces validated patterns for the external-pattern loader in `.githooks/secrets-check.js`,
which the vault's bash pre-commit hook invokes on top of its built-in patterns. Its
contract is documented below.

## Input

Findings from `/security-sweep`, `/code-review`, or a described vulnerability
class (e.g. "hardcoded internal hostnames", "raw SQL string concatenation",
"a private key committed as base64"). Work from the **pattern**, not the one
specific instance.

## Procedure

1. **Derive** a line-oriented regex for each finding — it must match the class
   on a single line (the loader tests line by line).
2. **Validate** every candidate before proposing it. Reject any that fail:
   - compiles under `new RegExp(src)`;
   - passes a safe-regex pre-filter — no nested quantifier shapes (`(a+)+`,
     `(.*)*`, `(ab+)*`), no absurd bounded repeats (`{1000,}`). This mirrors
     `isSafeRegex()` in `secrets-check.js`;
   - on a quick timed run, **matches a positive sample, does NOT match a benign
     sample, and returns fast** on a long input. Example check:
     `node -e 'const re=new RegExp(process.argv[1]); const t=Date.now(); re.test("x".repeat(50000)); if(Date.now()-t>100) throw new Error("slow regex")' "<pattern>"`
3. **Present** the surviving candidates as `{ name, re, severity }` entries with
   their positive/benign samples. Wait for approval.
4. **Write** only approved entries to the repo's `.claude/scan-patterns.json`
   (a JSON array; create it if absent). Never write an unvalidated or unsafe
   pattern, and never write without approval.

## Loader contract (`secrets-check.js`)

- `.claude/scan-patterns.json` is an array of `{ "name": string, "re": string,
  "severity"?: string }`. `re` is a JavaScript regex **source string** (no
  slashes, no flags).
- Loaded patterns run in addition to the bash hook's built-in patterns, and are
  tested only against the first `EXTERNAL_MAX_LINE` (2000) chars of each line —
  the guard that stops a pathological pattern from hanging a commit.
- The hook already skips malformed entries, unsafe regexes, and ones that don't
  compile, logging a warning — but validate up front so nothing is silently
  dropped.

Report-only until the user approves the pattern set.
