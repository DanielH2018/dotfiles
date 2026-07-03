---
description: "Run full PR review, then triage and fix agreed-upon issues. Use with ralph-loop for iterative refinement."
---

This skill runs one iteration of the review-fix pipeline. It is invoked by `/review-loop` via Ralph Loop. The autonomy mode is passed as `$ARGUMENTS` (one of: `auto`, `confirm`, `default`).

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

1. **code-reviewer** (`subagent_type: "pr-review-toolkit:code-reviewer"`)
2. **silent-failure-hunter** (`subagent_type: "pr-review-toolkit:silent-failure-hunter"`)

If the `pr-review-toolkit` agents are not in the available-agents list on this machine,
substitute: `feature-dev:code-reviewer` for the code-reviewer, and a `general-purpose`
agent prompted to hunt silent failures (swallowed exceptions, empty catch blocks,
errors logged-and-ignored, missing propagation) for the silent-failure-hunter.

Each agent's prompt MUST include:
1. The list of changed files to review
2. The exclusion list from Setup (if any), with this instruction: "Do not raise any finding that matches an item in the PREVIOUSLY TRIAGED list below. Match by file path and description similarity, not line numbers. These have already been triaged in a previous iteration."
3. "Review only the listed changed files. Run `git diff main...HEAD` and `git diff` to see the changes."

All findings land in session context.

---

## Phase 2 — Arbiter

### Safety net: prior triage

If a finding from Phase 1 still matches a previously-triaged entry despite the exclusion list, immediately classify it as `SKIP`. Match by file path and description similarity, not line numbers.

### Classification

You are the arbiter. Follow the classification logic from the `review-arbiter` skill:

For each finding from Phase 1:

1. **Verify:** Read the actual code at the cited file:line. If the finding is stale or already fixed, classify as SKIP.
2. **Classify** as one of:
   - `SKIP` — false positive, stylistic nit, adds unnecessary complexity, or already fixed
   - `HAIKU-FIX` — single-line mechanical fix (null check, typo, simple rename, obvious one-liner)
   - `SONNET-FIX` — multi-line logic change, cross-file edit, behavioral reasoning required
   - When in doubt, choose SONNET-FIX.
3. **Apply autonomy mode** (from `$ARGUMENTS`):
   - `auto`: proceed with all non-SKIP findings immediately
   - `default`: auto-proceed on bugs/security; present subjective/architectural findings and ask the user (numbered list for quick response)
   - `confirm`: present full classification table, wait for user approval

Produce the approved fixes list and skipped list before proceeding.

---

## Phase 3 — Fix (parallel agents)

### Grouping

Group all approved findings by file path. All findings for the same file MUST go to the same agent.

### Model selection

For each file group:
- All findings are `HAIKU-FIX` → use `model: "haiku"`
- Any finding is `SONNET-FIX` → use `model: "sonnet"`

### Agent cap

Maximum 5 parallel agents. If there are more than 5 file groups:
- Sort file groups by number of findings (ascending)
- Merge the smallest HAIKU-only groups together until at or under 5 agents
- Never merge SONNET groups with other file groups

### Dispatch

Spawn all fix agents in a SINGLE message using multiple Agent tool calls so they run in parallel. Use `subagent_type: "implementer"` for each.

Each agent's prompt MUST include:
1. The file path(s) it owns
2. Each finding: file, line number, classification, description, and arbiter reasoning
3. This instruction: "Fix only the listed findings. Do not refactor, clean up, or modify any surrounding code. Do not add comments, docstrings, or type annotations to code you didn't change. Read the file first, then apply each fix."

### Verify

After all agents complete, read each modified file to confirm the agents made the expected changes. If an agent failed to apply a fix, note it for the summary.

---

## Phase 4 — Test and commit

### Test detection

Check for a test command (first match wins):
1. `package.json` exists and has a `scripts.test` field → run `npm test`
2. `gradlew` file exists → run `./gradlew test`
3. `build.gradle.kts` or `build.gradle` exists → run `gradle test`
4. `pytest.ini`, or `pyproject.toml`/`setup.cfg` with `[tool.pytest]` → run `pytest`
5. `Makefile` exists with a `test` target → run `make test`
6. Nothing found → skip tests, log: "No test suite detected, skipping tests."

### On test pass

Stage all modified files and commit with this message format:

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

### On test fail

Do NOT commit. Do NOT revert. Log the test failure output. The next iteration will see the dirty working tree and the failure context.

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
