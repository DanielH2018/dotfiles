# Freeze acceptance checks (Phase 2.5 of review-and-fix)

Before dispatching any fix agent, turn the approved findings into deterministic
acceptance checks where possible, then **freeze** them by committing to git. This ports
the "frozen checks" pattern: the fix agents never see a mutable grading target, and the
fixes are graded by a script in Phase 4 — not by a model self-assessing its own work.

For each approved finding that can be expressed as a falsifiable shell check, add a line
to `.claude/checks/review-loop.checks`:

```
- RUN: `grep -c "TODO" src/x.ts` -> match:"0"
- RUN: `npm run typecheck` -> exit:0
- RUN: `npm test -- x.test.ts` -> exit:0
```

Grammar: `- RUN: \`command\` -> exit:N` and/or `match:"literal substring"` (both on one
line are ANDed). `match:` is a **literal substring** against combined stdout+stderr,
never a regex.

Findings that are subjective or structural (e.g. "this abstraction leaks") usually can't
be expressed as a shell check — skip those; they stay covered by the Phase 2 arbiter
verification and the Phase 3 file re-read. Authoring zero checks is fine; this phase is
purely additive.

Then freeze before dispatch:

```
git add .claude/checks/review-loop.checks
git commit -m "review-loop: freeze acceptance checks (iteration M)"
```

On later iterations, append new checks and re-commit (re-freeze) before dispatching again.

The runner that grades these in Phase 4 is `~/.claude/scripts/check-runner.mjs`.
