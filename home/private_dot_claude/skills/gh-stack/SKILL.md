---
description: |
    Manage stacked branches and pull requests with the gh-stack GitHub CLI extension. Use when the user wants to create, push, rebase, sync, navigate, or view stacks of dependent PRs. Triggers on tasks involving stacked diffs, dependent pull requests, branch chains, or incremental code review workflows.
metadata:
    author: github
    github-path: skills/gh-stack
    github-ref: refs/tags/v0.0.6
    github-repo: https://github.com/github/gh-stack
    github-tree-sha: d690ac020267120882a2851d4a10404030565db5
    version: 0.0.6
name: gh-stack
---
# gh-stack

`gh stack` is a [GitHub CLI](https://cli.github.com/) extension for managing **stacked branches and pull requests**. A stack is an ordered list of branches where each branch builds on the one below it, rooted on a trunk branch (typically the repo's default branch). Each branch maps to one PR whose base is the branch below it, so reviewers see only the diff for that layer.

```
main (trunk)
 └── feat/auth-layer     → PR #1 (base: main)               - bottom (closest to trunk)
  └── feat/api-endpoints → PR #2 (base: feat/auth-layer)
   └── feat/frontend     → PR #3 (base: feat/api-endpoints) - top (furthest from trunk)
```

The **bottom** of the stack is the branch closest to the trunk, and the **top** is the branch furthest from the trunk. Each branch inherits from the one below it. Navigation commands (`up`, `down`, `top`, `bottom`) follow this model: `up` moves away from trunk, `down` moves toward it.

## When to use this skill

Use this skill when the user wants to:

- Break a large change into a chain of small, reviewable PRs
- Create, rebase, push, or sync a stack of dependent branches
- Navigate between layers of a branch stack
- View the status of stacked PRs
- Tear down and rebuild a stack to remove, reorder, or rename branches

## Prerequisites

The GitHub CLI (`gh`) v2.0+ must be installed and authenticated. Install the extension with:

```bash
gh extension install github/gh-stack
```

Before using `gh stack`, configure git to prevent interactive prompts:

```bash
git config rerere.enabled true           # remember conflict resolutions (skips prompt on init)
git config remote.pushDefault origin     # if multiple remotes exist (skips remote picker)
```

## Agent rules

**Every `gh stack` command must run non-interactively** — anything that would prompt hangs the session indefinitely. The flags that matter:

- `view` → always `--json`. Bare `view` and `--short` both launch a TUI an agent cannot drive.
- `submit` → always `--auto`, or it prompts for a title on each new PR.
- `init`, `add`, `checkout` → pass branch names or PR numbers positionally; bare invocations prompt.
- `--remote <name>` when multiple remotes exist (or set `git config remote.pushDefault origin`), otherwise `push`, `submit`, `sync`, `link`, and `checkout` open a remote picker.

Two hangs that aren't about flags:

- With a prefix set, pass only the suffix to `add` — under prefix `feat`, `gh stack add auth` gives `feat/auth`, while `gh stack add feat/auth` gives `feat/feat/auth`.
- `checkout <pr-number>` against branches that already hold a different local stack triggers an unbypassable conflict prompt. Run `gh stack unstack` first, then retry. (A branch shared across stacks exits with code 6 instead — check out a non-shared branch.)

## Working in a stack

- Stage with standard `git add` / `git commit` rather than the `-Am` shortcut — stacked PRs work best when each branch holds a deliberate, logical change set.
- To change a lower layer, navigate to it (`gh stack down`, `checkout`, or `bottom`), commit there, run `gh stack rebase --upstack`, then come back up. Don't work around a missing lower-layer change at the layer you happen to be on.
- For branches managed by an external tool (jj, Sapling), use `gh stack link branch-a branch-b` — it doesn't rely on local tracking state. Needs at least 2 branches or PR numbers.

## Thinking about stack structure

Each branch in a stack should represent a **discrete, logical unit of work** that can be reviewed independently. The changes within a branch should be cohesive—they belong together and make sense as a single PR.

### Dependency chain

Stacked branches form a dependency chain: each branch builds on the one below it. This means **foundational changes must go in lower (earlier) branches**, and code that depends on them goes in higher (later) branches.

**Plan your layers before writing code.** For example, a full-stack feature might be structured like this (use branch names relevant to your actual task, not these generic ones):

```
main (trunk)
 └── feat/data-models    ← shared types, database schema
  └── feat/api-endpoints ← API routes that use the models
   └── feat/frontend-ui  ← UI components that call the APIs
    └── feat/integration ← tests that exercise the full stack
```

This is illustrative — choose branch names and layer boundaries that reflect the specific work you're doing. The key principle is: if code in one layer depends on code in another, the dependency must be in the same branch or a lower one.

### Branch naming

Prefer initializing stacks with a prefix (`-p`). Prefixes group branches under a namespace (e.g., `feat/auth`, `feat/api`) and keep branch names clean and consistent. When a prefix is set, pass only the suffix to subsequent `add` calls — the prefix is applied automatically. Without a prefix, you'll need to pass the full branch name each time.

### Staging changes deliberately

The main reason to use `git add` and `git commit` directly is to control **which changes go into which branch**. When you have multiple files in your working tree, you can stage a subset for the current branch, commit them, then create a new branch and stage the rest there:

```bash
# You're on feat/data-models with several new files in your working tree.
# Stage only the model files for this branch:
git add internal/models/user.go internal/models/session.go
git commit -m "Add user and session models"

git add db/migrations/001_create_users.sql
git commit -m "Add user table migration"

# Now create a new branch for the API layer and stage the API files there:
gh stack add api-routes # created & switched to feat/api-routes branch
git add internal/api/routes.go internal/api/handlers.go
git commit -m "Add user API routes"
```

This keeps each branch focused on one concern. Multiple commits per branch are fine — the key is that all commits in a branch relate to the same logical concern, and changes that belong to a different concern go in a different branch.

### When to create a new branch

Create a new branch (`gh stack add`) when you're starting a **different concern** that depends on what you've built so far. Signs it's time for a new branch:

- You're switching from backend to frontend work
- You're moving from core logic to tests or documentation
- The next set of changes has a different reviewer audience
- The current branch's PR is already large enough to review

### One stack, one story

Think of a stack from the reviewer's perspective: the stack of PRs should **tell a cohesive story** about a feature or project. A reviewer should be able to read the PRs in sequence and understand the progression of changes, with each PR being a small, logical piece of the whole.

**When to use a single stack:** All the branches are part of the same feature, project, or closely related effort. Even if the work spans multiple concerns (models, API, frontend), they're all building toward the same goal.

**When to create a separate stack:** The work is unrelated to your current stack — a different feature, a bug fix in an unrelated area, or an independent refactor. Don't mix unrelated work into a single stack just because you happen to be working on both. Start a new stack with `gh stack init` or switch to an existing stack with `gh stack checkout` for each distinct effort.

Small, incidental fixes (e.g., fixing a typo you noticed) can go in the current stack if they're trivial. But if a change grows into its own project, it deserves its own stack.

## Quick reference

| Task | Command |
|------|---------|
| Create a stack (recommended) | `gh stack init -p feat auth` |
| Create a stack without prefix | `gh stack init auth` |
| Create a stack of multiple branches | `gh stack init auth api frontend` |
| Adopt existing branches | `gh stack init existing-branch-a existing-branch-b` |
| Set custom trunk | `gh stack init --base develop branch-a` |
| Add a branch to stack (suffix only if prefix set) | `gh stack add api-routes` |
| Add branch + stage all + commit | `gh stack add -Am "message" api-routes` |
| Push branches to remote | `gh stack push` |
| Push to specific remote | `gh stack push --remote origin` |
| Push branches + create draft PRs | `gh stack submit --auto` |
| Create PRs as ready for review | `gh stack submit --auto --open` |
| Sync (fetch, rebase, push) | `gh stack sync` |
| Sync with specific remote | `gh stack sync --remote origin` |
| Sync and prune merged branches | `gh stack sync --prune` |
| Rebase entire stack | `gh stack rebase` |
| Rebase upstack only | `gh stack rebase --upstack` |
| Rebase without trunk | `gh stack rebase --no-trunk` |
| Continue after conflict | `gh stack rebase --continue` |
| Abort rebase | `gh stack rebase --abort` |
| View stack details (JSON) | `gh stack view --json` |
| Switch branches up/down in stack | `gh stack up [n]` / `gh stack down [n]` |
| Switch to top/bottom branch | `gh stack top` / `gh stack bottom` |
| Check out by PR | `gh stack checkout 42` |
| Check out by branch (local only) | `gh stack checkout feature-auth` |
| Tear down a stack to restructure it | `gh stack unstack` |

---

## Workflows and command reference

Both live alongside this file and are read on demand — don't load them until the task needs them:

- **`references/workflows.md`** — worked end-to-end examples: creating a stack, adding a layer, rebasing after trunk moves, syncing, navigating, and recovering from conflicts.
- **`references/commands.md`** — the full per-subcommand reference: every flag, argument, and JSON schema.

The quick-reference table above covers the common path; reach for `commands.md` when you need a flag it doesn't list.

## Output conventions

- **Status messages** go to **stderr** with emoji prefixes: `✓` (success), `✗` (error), `⚠` (warning), `ℹ` (info).
- **Data output** (e.g., `view --json`) goes to **stdout**.
- When piping output, use `2>/dev/null` to suppress status messages if only data output is needed.

## Exit codes and error recovery

| Code | Meaning | Agent action |
|------|---------|-------------|
| 0 | Success | Proceed normally |
| 1 | Generic error | Read stderr for details; may indicate commit/push failure |
| 2 | Not in a stack | Run `gh stack init` to create a stack first |
| 3 | Rebase conflict | Parse stderr for conflicted file paths, resolve conflicts, run `gh stack rebase --continue` |
| 4 | GitHub API failure | Check `gh auth status`, retry the command |
| 5 | Invalid arguments | Fix the command invocation (check flags and arguments) |
| 6 | Disambiguation required | A branch belongs to multiple stacks. Run `gh stack checkout <specific-branch>` to switch to a non-shared branch first |
| 7 | Rebase already in progress | Run `gh stack rebase --continue` (after resolving conflicts) or `gh stack rebase --abort` to start over |
| 8 | Stack is locked | Another `gh stack` process is writing the stack file. Wait and retry — the lock times out after 5 seconds |
| 9 | Stacked PRs unavailable | The repository does not have stacked PRs enabled. `submit` will offer to create regular (unstacked) PRs in interactive mode |

## Known limitations

1. **Stacks are strictly linear.** Branching stacks (multiple children on a single parent) are not supported. Each branch has exactly one parent and at most one child. If you need parallel workstreams, use separate stacks.
2. **Stack disambiguation cannot be bypassed.** If the current branch is the trunk of multiple stacks, commands error with code 6. Check out a non-shared branch first.
3. **Multiple remotes require `--remote` or config.** If more than one remote is configured, pass `--remote <name>` or set `remote.pushDefault` in git config before running `push`, `sync`, or `rebase`.
4. **Merging PRs:** Merging Stacked PRs from the CLI is not supported yet. Direct users to open the PR URL in a browser to merge PRs.
5. **Remote stack checkout requires a PR number.** `checkout` with a branch name only works with locally tracked stacks. Use a PR number (e.g. `gh stack checkout 123`) to pull stacks from GitHub.
6. **PR title and body are auto-generated.** There is no flag to set a custom PR title or body during `submit`. The title and body are generated from commit messages plus a footer. Use `gh pr edit` to modify PR title and body after creation.
