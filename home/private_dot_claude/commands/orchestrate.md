---
description: "Launch a read-only background orchestrator for a repo/branch (appears in Agent View)."
argument-hint: "[repo] [-w NAME | -b BRANCH] [--fresh] [-m TASK]"
---

Launch a background orchestrator for the given target. It plans and dispatches
sandboxed implementers via `sandbox-dispatch`, but cannot edit files itself — all
implementation happens inside `claude-sandbox`.

The TUI can't tab-complete argument values, so surface the choices when the target is
underspecified (same sources the shell completion uses); otherwise skip straight to launch:
- No repo in `$ARGUMENTS` → list options with `ls -1 ~/Repositories`.
- Repo given but the worktree/branch is unclear or the user asks → run
  `claude-sandbox --complete-worktrees <repo>` and `claude-sandbox --complete-branches <repo>`
  and present the results to pick from.

Once the target is clear, run exactly this, passing the user's arguments through verbatim:

```
claude-orchestrate --bg $ARGUMENTS
```

`$ARGUMENTS` is a repo (a bare name resolves under `~/Repositories`) plus optional
`-w NAME` / `-b BRANCH` / `--fresh`, e.g. `airflow -b my-feature`.
Append `-m "<task>"` to seed the orchestrator with an initial task.

Then report the background agent that was dispatched and note that it appears in the
Agent View. Do not perform the implementation work yourself.
