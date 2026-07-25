---
description: "Iterative Claude Code setup review and fix loop. Usage: /review-setup-loop [max-iterations] [--auto|--confirm]"
disable-model-invocation: true
---

Parse `$ARGUMENTS`: the first bare number is max iterations (default `3`), and `--auto`/`--confirm` set the autonomy mode (default `default`); then delete `.claude/review-setup-triage.local.md` if it exists so each `/review-setup-loop` invocation starts with a clean triage slate.

Construct the Ralph Loop prompt:

```
"/review-setup [MODE]" --max-iterations [N] --completion-promise "NO FIXES NEEDED"
```

Where `[MODE]` is the autonomy mode and `[N]` is the max iterations.

Invoke the `ralph-loop:ralph-loop` skill with the constructed arguments.
