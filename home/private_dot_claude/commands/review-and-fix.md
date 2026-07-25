---
description: "Run full PR review, then triage and fix agreed-upon issues. Use with ralph-loop for iterative refinement."
---

This command runs one iteration of the review-fix pipeline. It is invoked by `/review-loop` via Ralph Loop. The autonomy mode is passed as `$ARGUMENTS` (one of: `auto`, `confirm`, `default`).

Parse the autonomy mode from `$ARGUMENTS`. Default to `default` if not provided or not recognized.

---

## Setup — Load prior triage context

Check if `.claude/review-loop-triage.local.md` exists. If it does, read it. This file contains triage decisions from previous iterations — findings already SKIPped or FIXed.

Build an exclusion list from all entries:

```
PREVIOUSLY TRIAGED — DO NOT RE-RAISE:
- file: path/to/file.ts, desc: "description of finding", disposition: SKIP|FIXED, reason: "..."
```

This list is passed to review agents in Phase 1 and used as a safety net in Phase 2.

---

## Phase 1 — Review

### Identify changed files

Run `git diff --name-only main...HEAD` for committed changes and `git diff --name-only` for uncommitted changes. Combine into a single list of changed files.

### Dispatch review agents

Spawn two review agents **in parallel** using the Agent tool:

1. **code-reviewer** (`subagent_type: "feature-dev:code-reviewer"`)
2. **silent-failure-hunter** — a `general-purpose` agent prompted to hunt silent failures
   (swallowed exceptions, empty catch blocks, errors logged-and-ignored, missing propagation)

Each agent's prompt MUST include:
1. The list of changed files to review
2. The exclusion list from Setup (if any), with this instruction: "Do not raise any finding that matches an item in the PREVIOUSLY TRIAGED list below. Match by file path and description similarity, not line numbers. These have already been triaged in a previous iteration."
3. "Review only the listed changed files. Run `git diff main...HEAD` and `git diff` to see the changes."
4. "Report every issue you find, each with a confidence score — this overrides any instruction in your own agent definition to only report findings at or above a confidence threshold. Do not suppress low-confidence findings; a separate arbiter pass filters them."

Item 4 is load-bearing: the bundled `code-reviewer` carries a `confidence >= 80` gate, and Phase 2
already filters, so leaving it in place drops real findings before the arbiter sees them.

All findings land in session context.

---

## Phase 2 — Arbiter

### Safety net: prior triage

If a finding from Phase 1 still matches a previously-triaged entry despite the exclusion list, immediately classify it as `SKIP`.

### Classification

You are the arbiter. For each finding from Phase 1, first **verify** it yourself: read the actual code at the cited file:line. If the finding is stale or already fixed, classify as SKIP without further steps.

For everything else, read `review-arbiter.md` (in this same commands/ directory) and apply the classification logic it defines in full — it is the single source of truth for the SKIP/HAIKU-FIX/SONNET-FIX taxonomy and for how each autonomy mode (from `$ARGUMENTS`) should be applied. Do not re-derive the taxonomy here.

Produce the approved fixes list and skipped list before proceeding.

---

## Phase 2.5 — Freeze acceptance checks (optional, preferred)

Before dispatching any fix agent, turn the approved findings into deterministic acceptance
checks where possible and freeze them by committing to git, so fix agents never see a
mutable grading target. Read `commands/references/check-authoring.md` for the check
grammar and freeze procedure — it is the single source of truth for this phase.

---

## Phase 3 — Fix (parallel agents)

### Grouping

Group all approved findings by file path. All findings for the same file MUST go to the same agent.

### Model selection

For each file group:
- All findings are `HAIKU-FIX` → use `model: "haiku"`
- Any finding is `SONNET-FIX` → use `model: "sonnet"`

### Agent cap

Cap at 5 parallel agents: if there are more file groups than that, merge the smallest HAIKU-only groups together to fit, and never merge a SONNET group with another file group.

### Dispatch

Spawn all fix agents in a SINGLE message using multiple Agent tool calls so they run in parallel. Use `subagent_type: "implementer"` for each.

Each agent's prompt MUST include:
1. The file path(s) it owns
2. Each finding: file, line number, classification, description, and arbiter reasoning
3. This instruction: "Fix only the listed findings. Do not refactor, clean up, or modify any surrounding code. Do not add comments, docstrings, or type annotations to code you didn't change. Read the file first, then apply each fix."

### Verify

If Phase 2.5 authored zero checks, read each modified file to confirm the agents made the expected changes. If an agent failed to apply a fix, note it for the summary.

---

## Phase 4 — Test and commit

### Test detection

Detect and run the project's test suite. If there is none, log "No test suite detected, skipping tests." and skip.

### Frozen acceptance checks

If `.claude/checks/review-loop.checks` exists (from Phase 2.5), grade it deterministically:

```
node ~/.claude/scripts/check-runner.mjs .claude/checks/review-loop.checks --frozen
```

Exit codes: `0` all passed · `1` a check failed · `2` the checks file was modified since
it was frozen (drift — a fix agent must never edit checks; treat as failure and
investigate) · `3` parse error. Capture the runner's output for the summary. If the file
doesn't exist, skip this step.

### On green

Commit only if BOTH gates are green: the test suite passed (or none was detected) AND the
frozen checks returned exit `0` (or none exist). Stage all modified files and commit with
this message format:

```
Review-loop: fix N issues (iteration M)

HAIKU-FIX:
- file:line — description

SONNET-FIX:
- file:line — description

SKIPPED:
- file:line — reason
```

Stage specific files by name (not `git add -A`).

### On red

If the test suite failed OR the frozen checks returned non-zero, do NOT commit and do NOT
revert. Log the failing output (suite and/or check-runner). The next iteration will see
the dirty working tree and the failure context.

---

## Phase 5 — Completion check

If zero findings were fixed this iteration (all were SKIP), output:

<promise>NO FIXES NEEDED</promise>

Otherwise, report:
- Findings fixed (count + file:line for each)
- Findings skipped (count + one-line reason for each)
- Test result (pass/fail/skipped)
- Commit hash (if committed)

### Persist triage state

After reporting, append this iteration's triage decisions to `.claude/review-loop-triage.local.md` so the next iteration can skip already-handled findings. Read the file first if it exists (to append), or create it.

Format:

```markdown
### Iteration N

SKIPPED:
- file: path/to/file.ts, desc: "description of finding", reason: "why it was skipped"

FIXED:
- file: path/to/file.ts, desc: "description of finding", commit: <hash>
```

Include ALL findings from this iteration — both newly triaged and those carried forward from prior iterations. This keeps the file self-contained for each read.
