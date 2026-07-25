---
description: "Iterative PR review and fix loop. Usage: /review-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

Parse `$ARGUMENTS`: the first bare number is max iterations (default `5`), and `--auto`/`--confirm` set the autonomy mode (default `default`); then delete `.claude/review-loop-triage.local.md` if it exists so each `/review-loop` invocation starts with a clean triage slate.

Construct the Ralph Loop prompt. The prompt must pass the autonomy mode to `/review-and-fix` so each iteration knows how to behave:

```
"/review-and-fix [MODE]" --max-iterations [N] --completion-promise "NO FIXES NEEDED"
```

Where `[MODE]` is the autonomy mode (`auto`, `confirm`, or `default`) and `[N]` is the max iterations.

Invoke the `ralph-loop:ralph-loop` skill with the constructed arguments.
