---
description: "Iterative PR review and fix loop. Usage: /review-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

Parse the arguments from `$ARGUMENTS`:

1. **Max iterations:** Extract the first bare number. Default to `5` if not provided.
2. **Autonomy mode:** Check for flags:
   - `--auto` → set mode to `auto`
   - `--confirm` → set mode to `confirm`
   - Neither → set mode to `default`

Before starting the loop, delete `.claude/review-loop-triage.local.md` if it exists — each `/review-loop` invocation starts with a clean triage slate.

Construct the Ralph Loop prompt. The prompt must pass the autonomy mode to `/review-and-fix` so each iteration knows how to behave:

```
"/review-and-fix [MODE]" --max-iterations [N] --completion-promise "NO FIXES NEEDED"
```

Where `[MODE]` is the autonomy mode (`auto`, `confirm`, or `default`) and `[N]` is the max iterations.

Invoke the `ralph-loop:ralph-loop` skill with the constructed arguments.
