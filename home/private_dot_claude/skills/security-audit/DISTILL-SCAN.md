# Distill findings into scan patterns

A model-driven security review is expensive and runs once. Distilling its findings
into a deterministic ruleset lets a pre-commit hook re-run the check on every commit
at no model cost. This companion derives and validates the patterns. Where they land
depends on how the repo's pre-commit hook already scans.

## When to distill

Distill a finding only when it describes a recurring class: a hardcoded internal
hostname, raw SQL string concatenation, a private key committed as base64. Skip a
one-off finding that cannot recur. Work from the class, not the one instance.

Distill mode needs concrete findings: output from a diff review or full audit in
this skill, from `/code-review`, or a vulnerability class the user describes. It
does not hunt for new findings.

## Procedure

1. Derive a line-oriented regex for each finding. It must match the class on a
   single line, because the loader tests line by line.
2. Validate every candidate before proposing it. Never present one that fails
   any of these checks:
    - it compiles under `new RegExp(src)`;
    - it passes a safe-regex pre-filter: no nested quantifier shapes (`(a+)+`,
      `(.*)*`, `(ab+)*`) and no absurd bounded repeats (`{1000,}`), which are the
      classic ReDoS shapes;
    - it matches a positive sample, does not match a benign sample, and returns
      fast on a long input. Run a timed check like this:

        ```bash
        node -e 'const re=new RegExp(process.argv[1]); const t=Date.now();
        re.test("x".repeat(50000));
        if (Date.now()-t>100) throw new Error("slow regex")' "<pattern>"
        ```

3. Present the surviving candidates with their positive and benign samples, as
   entries in this shape:

    ```json
    { "name": "hardcoded-internal-host", "re": "internal\\.example\\.com", "severity": "high" }
    ```

    Then wait for approval, even when every candidate passed validation.
4. Write only approved entries into the repo's pre-commit scan, as described
   below. The step is done when each approved entry is written and each rejected
   one is named in your reply as not written.

## Where the patterns go

Read the repo's pre-commit hook first, integrate to match how it scans, and
confirm the target with the user before writing:

- **External pattern file.** A hook that loads a JSON array, such as the vault's
  `secrets-check.js` reading `.claude/scan-patterns.json`. Append each entry as
  `{ "name": string, "re": string, "severity"?: string }`, where `re` is a
  JavaScript regex source string with no slashes and no flags. Create the file if
  the hook expects one and it is absent.
- **Inline pattern list.** A self-contained bash hook that greps added lines
  against a `patterns='a|b|c'` alternation. Add each validated regex as a new
  alternation branch there.

Either way the patterns are line-oriented. Keep each one anchored or bounded so a
pathological input cannot hang a commit. Do not duplicate a built-in pattern the
hook already covers.
