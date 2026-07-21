---
description: "Launch a read-only background orchestrator for a repo + worktree/branch (appears in Agent View)."
argument-hint: "[repo] (-w NAME | -b BRANCH) [--fresh]"
---

Launch a background orchestrator for a repo and a worktree/branch. It plans and
dispatches sandboxed implementers via `sandbox-dispatch`, but cannot edit files itself —
all implementation happens inside `claude-sandbox`.

A repository AND a worktree/branch are BOTH required before spawning. Resolve them in
this order, asking the user and listing valid options for whatever is missing:

1. **Repository (ask first).** If `$ARGUMENTS` has no repo, list the options with
   `ls -1 ~/Repositories` and ask the user to pick one. Do not proceed to step 2 until
   the repo is known.
2. **Worktree or branch.** Once the repo is known, if `$ARGUMENTS` has neither `-w` nor
   `-b`, list the options with `claude-sandbox --complete-worktrees <repo>` and
   `claude-sandbox --complete-branches <repo>`, and ask the user to choose an existing
   worktree/branch or give a new worktree name.

Only once you have BOTH a repo and a `-w NAME`/`-b BRANCH`, run exactly:

```
claude-orchestrate --bg <repo> <-w NAME | -b BRANCH>
```

Pass `--fresh` if the user wants a new session, and `-m "<task>"` to seed an initial task.
Then report the background agent that was dispatched and note it appears in the Agent
View. Do not perform the implementation work yourself, and do not spawn without both a
repo and a worktree/branch.
