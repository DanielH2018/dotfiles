---
description: "Iterative PR review and fix loop. Usage: /review-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

# Iterative PR review and fix loop

## When to use

Use when a branch needs more than one review-fix pass — a large diff, or one where earlier
fixes are likely to surface new findings. For a single pass, run `/review-and-fix` directly
and skip the loop.

## Parameters

| Parameter | Value |
|---|---|
| `ITERATION_COMMAND` | `/review-and-fix` |
| `DEFAULT_MAX` | `5` |
| `TRIAGE_FILE` | `.claude/review-loop-triage.local.md` |

## Steps

Follow `~/.claude/command-references/loop-driver.md` with the parameters above. It holds the argument parsing,
the triage-ledger reset, and the Ralph Loop prompt shape — never restate those steps here,
so the two loop commands cannot drift apart.
