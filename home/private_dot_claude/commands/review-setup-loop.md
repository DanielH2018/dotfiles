---
description: "Iterative Claude Code setup review and fix loop. Usage: /review-setup-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

Parse the arguments from `$ARGUMENTS`:

1. **Max iterations:** Extract the first bare number. Default to `3` if not provided.
2. **Autonomy mode:** Check for flags:
   - `--auto` → set mode to `auto`
   - `--confirm` → set mode to `confirm`
   - Neither → set mode to `default`

Before starting the loop, delete `.claude/review-setup-triage.local.md` if it exists — each `/review-setup-loop` invocation starts with a clean triage slate.

Construct the Ralph Loop prompt:

```
"/review-setup [MODE]" --max-iterations [N] --completion-promise "NO FIXES NEEDED"
```

Where `[MODE]` is the autonomy mode and `[N]` is the max iterations.

Invoke the `ralph-loop:ralph-loop` skill with the constructed arguments.
