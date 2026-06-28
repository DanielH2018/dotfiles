---
description: "Audit and fix Claude Code config (hooks, settings, CLAUDE.md, commands). Use with /review-setup-loop for iterative refinement."
---

This skill runs one iteration of the setup review pipeline. It is invoked by `/review-setup-loop` via Ralph Loop, or standalone for a single pass. The autonomy mode is passed as `$ARGUMENTS` (one of: `auto`, `confirm`, `default`).

Parse the autonomy mode from `$ARGUMENTS`. Default to `default` if not provided or not recognized.

---

## Setup — Load prior triage context

Check if `.claude/review-setup-triage.local.md` exists. If it does, read it. This file contains triage decisions from previous iterations.

Build an exclusion list from all entries:

```
PREVIOUSLY TRIAGED — DO NOT RE-RAISE:
- file: path/to/file, desc: "description of finding", disposition: SKIP|FIXED, reason: "..."
```

---

## Phase 1 — Read and audit

### Read everything (parallel)

Read all of these in parallel:
- `~/.claude/settings.json`
- `~/.claude/CLAUDE.md`
- All files in `~/.claude/docs/`
- All hooks in `~/.claude/hooks/`
- All commands in `~/.claude/commands/*.md`

### Run hook tests

If `~/.claude/hooks/*.test.*` files exist, run them. Note any failures.

### Audit hooks

For each hook script:
- Does it have a matching entry in `settings.json` hooks config?
- Is it executable? (`test -x`)
- Does it use `set -u` or equivalent?
- Are there shellcheck issues? (run `shellcheck` if available)
- Is the shebang correct?
- Are there dead code paths or unreachable logic?
- Does it handle missing dependencies gracefully?
- Does the settings.json hook entry have an appropriate `timeout`?

### Audit settings

Check `settings.json` for:
- Permission allow rules that overlap or conflict with deny rules
- Hooks referencing scripts that don't exist
- Unused or redundant permission rules
- Missing permissions that would reduce prompt fatigue (check `~/.claude/logs/permissions.json` for commands with high ask counts)
- Sandbox config consistency
- Missing timeouts on hook entries

### Audit CLAUDE.md and docs

Check for:
- Stale references to files/tools that no longer exist
- Inconsistencies between CLAUDE.md instructions and actual settings/hooks
- Missing documentation for hooks or commands that exist

### Audit commands

Check slash commands for:
- References to tools or paths that don't exist
- Consistency with CLAUDE.md conventions

### Filter findings

Drop any finding that matches the exclusion list from Setup. Match by file path and description similarity.

---

## Phase 2 — Triage

Classify each finding as one of:
- `SKIP` — false positive, stylistic nit, not worth fixing, or already fixed
- `FIX` — real bug, missing config, stale reference, or clear improvement

Apply autonomy mode:
- `auto`: proceed with all FIX findings immediately
- `default`: auto-proceed on bugs/security; present subjective findings and ask the user
- `confirm`: present full classification table, wait for user approval

---

## Phase 3 — Fix

### Auto-editable files (hooks, CLAUDE.md, docs, commands)

Fix directly. Keep changes minimal — fix bugs, don't refactor.

### settings.json

Batch all recommended changes and present as a single Edit operation. Explain each change before applying. In `auto` mode, apply without asking.

### Verify

Run hook tests again if any hooks were modified. Read modified files to confirm changes are correct.

---

## Phase 4 — Completion check

If zero findings were fixed this iteration (all were SKIP or no findings), output:

<promise>NO FIXES NEEDED</promise>

Otherwise, report:
- Findings fixed (count + file:line for each)
- Findings skipped (count + one-line reason for each)
- Test results (pass/fail)

### Persist triage state

Append this iteration's triage decisions to `.claude/review-setup-triage.local.md`:

```markdown
### Iteration N

SKIPPED:
- file: path/to/file, desc: "description of finding", reason: "why"

FIXED:
- file: path/to/file, desc: "description of finding"
```

## Rules

- Don't change behavior — fix bugs and fill gaps, don't redesign.
- Don't add features that weren't there.
- Run tests after modifying hook scripts.
- For settings.json, explain *why* each change matters before applying.
- If nothing needs fixing, say so. Don't manufacture improvements.
