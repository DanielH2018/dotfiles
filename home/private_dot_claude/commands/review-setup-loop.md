---
description: "Iterative Claude Code setup review and fix loop. Usage: /review-setup-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

# Iterative Claude Code setup review and fix loop

## When to use

Use when auditing the Claude Code config — hooks, settings, CLAUDE.md, commands — and one
pass is not enough, because fixing one hook often reveals the next. For a single pass, run
`/review-setup` directly and skip the loop.

## Parameters

| Parameter | Value |
|---|---|
| `ITERATION_COMMAND` | `/review-setup` |
| `DEFAULT_MAX` | `3` |
| `TRIAGE_FILE` | `.claude/review-setup-triage.local.md` |

## Steps

Follow `~/.claude/command-references/loop-driver.md` with the parameters above. It holds the argument parsing,
the triage-ledger reset, and the Ralph Loop prompt shape — never restate those steps here,
so the two loop commands cannot drift apart.
