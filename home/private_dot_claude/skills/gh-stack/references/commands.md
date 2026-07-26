# gh-stack command reference

Every subcommand, flag, and JSON schema. Loaded on demand from `SKILL.md`.


### Initialize a stack — `gh stack init`

Creates a new stack. **Always provide at least one branch name as a positional argument** — running without branch arguments triggers interactive prompts that agents cannot use.

```
gh stack init [flags] <branches...>
```

```bash
# Set a branch prefix (recommended — subsequent `add` calls only need the suffix)
gh stack init -p feat auth
# → creates feat/auth

# Multi-part prefix (slashes are fine — suffix-only rule still applies)
gh stack init -p monalisa/billing auth
# → creates monalisa/billing/auth

# Create a stack with new branches (no prefix — use full branch names)
gh stack init branch-a branch-b branch-c

# Use a different trunk branch
gh stack init --base develop branch-a branch-b

# Adopt existing branches into a stack (handled automatically if the branches exist)
gh stack init branch-a branch-b branch-c
```

| Flag | Description |
|------|-------------|
| `-b, --base <branch>` | Trunk branch (defaults to the repo's default branch) |
| `-p, --prefix <string>` | Branch name prefix. Subsequent `add` calls only need the suffix (e.g., with `-p feat`, `gh stack add auth` creates `feat/auth`) |

**Behavior:**

- Using `-p` is recommended — it simplifies branch naming for subsequent `add` calls
- Creates any branches that don't already exist (branching from the trunk branch)
- Existing branches are adopted automatically; missing branches are created from the trunk
- Checks out the last branch in the list
- Enables `git rerere` so conflict resolutions are remembered across rebases. On first run in a repo, this may trigger a confirmation prompt — pre-configure with `git config rerere.enabled true` to avoid it

---

### Add a branch — `gh stack add`

Add a new branch on top of the current stack. Must be run while on the topmost branch (or the trunk if the stack has no branches yet). **Always provide a branch name** — running without one triggers an interactive prompt.

```
gh stack add [flags] <branch>
```

**Recommended workflow — create the branch, then use standard git:**

```bash
# Create a new branch and switch to it (just the suffix — prefix is applied automatically)
gh stack add api-routes

# Write code, stage deliberately, and commit
git add internal/api/routes.go internal/api/handlers.go
git commit -m "Add user API routes"

# Make more commits on the same branch as needed
git add internal/api/middleware.go
git commit -m "Add rate limiting middleware"
```

**Shortcut — stage, commit, and branch in one command:**

```bash
# Create a new branch, stage all changes, and commit
gh stack add -Am "Add API routes" api-routes

# Create a new branch, stage tracked files only, and commit
gh stack add -um "Fix auth bug" auth-fix
```

| Flag | Description |
|------|-------------|
| `-m, --message <string>` | Create a commit with this message |
| `-A, --all` | Stage all changes including untracked files (requires `-m`) |
| `-u, --update` | Stage tracked files only (requires `-m`) |

**Behavior notes:**

- `-A` and `-u` are mutually exclusive.
- When the current branch has no commits (e.g., right after `init`), `add -Am` commits directly on the current branch instead of creating a new one.
- **Prefix handling:** Only pass the suffix when a prefix is set. `gh stack add api` with prefix `todo` → `todo/api`. Passing `todo/api` creates `todo/todo/api`. Without a prefix, pass the full branch name.
- If called from a branch that is not the topmost in the stack, exits with code 5: `"can only add branches on top of the stack"`. Use `gh stack top` to switch first.
- **Uncommitted changes:** When using `gh stack add branch-name` without `-Am`, any uncommitted changes (staged or unstaged) in your working tree carry over to the new branch. This is standard git behavior — the working tree is not touched. Commit or stash changes on the current branch before running `add` if you want a clean starting point on the new branch.

---

### Push branches to remote — `gh stack push`

Push all stack branches to the remote.

```
gh stack push [flags]
```

```bash
# Push all branches
gh stack push

# Push to specific remote
gh stack push --remote upstream
```

| Flag | Description |
|------|-------------|
| `--remote <name>` | Remote to push to (use if multiple remotes exist) |

**Behavior:**

- Pushes all active (non-merged) branches atomically (`--force-with-lease --atomic`)
- Does **not** create or update pull requests — use `gh stack submit` for that

**Output (stderr):**

- `Pushed N branches` summary

---

### Submit branches and create PRs — `gh stack submit`

Push all stack branches and create PRs on GitHub. **Always pass `--auto`** — without it, `submit` prompts for a PR title for each new branch.

```bash
# Submit and auto-title new PRs (required for non-interactive use)
gh stack submit --auto

# Submit and create PRs as ready for review (not drafts)
gh stack submit --auto --open
```

| Flag | Description |
|------|-------------|
| `--auto` | Auto-generate PR titles without prompting (**required** for non-interactive use) |
| `--open` | Mark new and existing PRs as ready for review |
| `--remote <name>` | Remote to push to (use if multiple remotes exist) |

**Behavior:**

- Pushes all active (non-merged) branches atomically (`--force-with-lease --atomic`)
- Creates a new PR for each branch that doesn't have one (base set to the first non-merged ancestor branch)
- After creating PRs, links them together as a **Stack** on GitHub (requires the repository to have stacks enabled)
- If stacks are not available (exit code 9), the repository does not have stacked PRs enabled. In interactive mode, `submit` offers to create regular (unstacked) PRs instead. In non-interactive mode, it exits with code 9.
- Syncs PR metadata for branches that already have PRs

**PR title auto-generation (`--auto`):**

- Single commit on branch → uses the commit subject as the PR title, commit body as PR body
- Multiple commits on branch → humanizes the branch name (hyphens/underscores → spaces) as the title

**Output (stderr):**

- `Created PR #N for <branch>` for each newly created PR
- `PR #N for <branch> is up to date` for existing PRs
- `Pushed and synced N branches` summary

---

### Link branches as a stack (no local tracking) — `gh stack link`

Link PRs into a stack on GitHub without creating any local tracking state. This is the recommended approach if you are managing stacked branches with other tools (jj, Sapling, git-town) and want to simply create GitHub Stacked PRs via an API.

```
gh stack link [flags] <branch-or-pr> <branch-or-pr> [...]
```

```bash
# Link branches into a stack (pushes, creates PRs, creates stack)
gh stack link branch-a branch-b branch-c

# Use a different base branch and mark PRs as ready for review
gh stack link --base develop --open branch-a branch-b branch-c

# Link existing PRs by number
gh stack link 10 20 30

# Add branches to an existing stack of PRs
gh stack link 42 43 feature-auth feature-ui
```

| Flag | Description |
|------|---------|
| `--base <branch>` | Base branch for the bottom of the stack (default: `main`) |
| `--open` | Mark new and existing PRs as ready for review |
| `--remote <name>` | Remote to push to (use if multiple remotes exist) |

**Behavior:**

- Arguments are provided in stack order (bottom to top)
- Each argument can be a branch name or a PR number. Numeric arguments are tried as PR numbers first; if no PR with that number exists, the argument is treated as a branch name
- Branch arguments are pushed to the remote automatically (non-force, atomic)
- For branches without open PRs, new PRs are created with auto-generated titles and the correct base branch chaining (first branch uses `--base`, subsequent branches use the previous branch)
- Existing PRs whose base branch doesn't match the expected chain are corrected automatically
- If the PRs are not yet in a stack, a new stack is created. If some PRs are already in a stack, the stack is updated (additive only — existing PRs are never removed)
- Does **not** create or modify any local state

**Output (stderr):**

- `Pushing N branches to <remote>...`
- `Found PR #N for branch <name>` for branches with existing PRs
- `Created PR #N for <branch> (base: <base>)` for newly created PRs
- `Updated base branch for PR #N to <base>` when base branches are corrected
- `Created stack with N PRs` or `Updated stack to N PRs`

---

### Sync the stack — `gh stack sync`

Fetch, rebase, push, and sync PR state in a single command. This is the recommended command for routine synchronization.

```
gh stack sync [flags]
```

| Flag | Description |
|------|-------------|
| `--remote <name>` | Remote to fetch from and push to (use if multiple remotes exist) |
| `--prune` | Delete local branches for merged PRs |

**What it does (in order):**

1. **Fetch** latest changes from the remote
2. **Fast-forward trunk** to match remote (skips if already up to date, warns if diverged)
3. **Cascade rebase** all stack branches onto their updated parents (only if trunk moved). Handles merged PRs automatically. If a conflict is detected, **all branches are restored** to their pre-rebase state and the command exits with code 3 — see [Handle rebase conflicts](#handle-rebase-conflicts-agent-workflow) for the resolution workflow
4. **Push** all active branches atomically
5. **Sync PR state** from GitHub and report the status of each PR
6. **Prune** — in interactive terminals, prompts to delete local branches for merged PRs. Use `--prune` to skip the prompt. In non-interactive environments, pruning only happens when `--prune` is passed explicitly

**Output (stderr):**

- `✓ Fetched latest changes from origin`
- `✓ Trunk main fast-forwarded to <sha>` or `✓ Trunk main is already up to date`
- `✓ Rebased <branch> onto <base>` per branch (if base moved)
- `✓ Pushed N branches`
- `✓ PR #N (<branch>) — Open` per branch
- `Merged: #N, #M` for merged branches
- `✓ Pruned <branch> (merged)` per pruned branch (when pruning)
- `✓ Stack synced`

---

### Rebase the stack — `gh stack rebase`

Pull from remote and cascade-rebase stack branches. Use this when `sync` reports a conflict or when you need finer control (e.g., rebase only part of the stack).

```
gh stack rebase [flags] [branch]
```

```bash
# Rebase the entire stack
gh stack rebase

# Rebase only branches from trunk to current branch
gh stack rebase --downstack

# Rebase only branches from current branch to top
gh stack rebase --upstack

# Rebase stack branches without pulling from or rebasing with trunk
gh stack rebase --no-trunk

# After resolving a conflict: stage files with `git add`, then:
gh stack rebase --continue

# Abort and restore all branches to pre-rebase state
gh stack rebase --abort
```

| Flag | Description |
|------|-------------|
| `--downstack` | Only rebase branches from trunk to the current branch |
| `--upstack` | Only rebase branches from the current branch to the top |
| `--no-trunk` | Skip trunk — only rebase stack branches onto each other (no fetch, no trunk rebase) |
| `--continue` | Continue after resolving conflicts |
| `--abort` | Abort and restore all branches |
| `--remote <name>` | Remote to fetch from (use if multiple remotes exist) |

| Argument | Description |
|----------|-------------|
| `[branch]` | Target branch (defaults to the current branch) |

**Conflict handling:** See [Handle rebase conflicts](#handle-rebase-conflicts-agent-workflow) in the Workflows section for the full resolution workflow.

**Merged PR detection:** If a branch's PR was merged on GitHub, the rebase automatically handles this using `--onto` mode and correctly replays commits on top of the merge target.

**Rerere (conflict memory):** `git rerere` is enabled by `init` so previously resolved conflicts are auto-resolved in future rebases.

**No-trunk mode:** Use `--no-trunk` to skip fetching from the remote and rebasing with the trunk branch. Only inter-branch rebases are performed (branch 2 onto branch 1, branch 3 onto branch 2, etc.). Useful when you only need to align stack branches with each other without pulling upstream changes.

---

### View the stack — `gh stack view`

Display the current stack's branches, PR status, and recent commits. **Always pass `--json`** — without it, this command launches an interactive TUI that agents cannot operate.

```bash
# Always use --json
gh stack view --json
```

| Flag | Description |
|------|-------------|
| `--json` | Output stack data as JSON to stdout (**required** for non-interactive use) |

**`--json` output format:**

```json
{
  "trunk": "main",
  "prefix": "feat",
  "currentBranch": "feat/api-routes",
  "branches": [
    {
      "name": "feat/auth",
      "head": "abc1234...",
      "base": "def5678...",
      "isCurrent": false,
      "isMerged": true,
      "needsRebase": false,
      "pr": {
        "number": 42,
        "url": "https://github.com/owner/repo/pull/42",
        "state": "MERGED"
      }
    },
    {
      "name": "feat/api-routes",
      "head": "789abcd...",
      "base": "abc1234...",
      "isCurrent": true,
      "isMerged": false,
      "needsRebase": false,
      "pr": {
        "number": 43,
        "url": "https://github.com/owner/repo/pull/43",
        "state": "OPEN"
      }
    }
  ]
}
```

Fields per branch:
- `name` — branch name
- `head` — current HEAD SHA
- `base` — parent branch's HEAD SHA at last sync
- `isCurrent` — whether this is the checked-out branch
- `isMerged` — whether the PR has been merged
- `needsRebase` — whether the base branch is not an ancestor (non-linear history)
- `pr` — PR metadata (omitted if no PR exists). `state` is `"OPEN"` or `"MERGED"`.

---

### Navigate the stack

Move between branches without remembering branch names. These commands are fully non-interactive.

```bash
gh stack up          # Move up one branch (further from trunk)
gh stack up 3        # Move up three branches
gh stack down        # Move down one branch (closer to trunk)
gh stack down 2      # Move down two branches
gh stack top         # Jump to the top of the stack (furthest from trunk)
gh stack bottom      # Jump to the bottom (first non-merged branch above trunk)
```

Navigation clamps to stack bounds. Merged branches are skipped when navigating from active branches.

---

### Check out a stack — `gh stack checkout`

Check out a stack from a pull request number or branch name. **Always provide an argument** — running `gh stack checkout` without arguments triggers an interactive selection menu.

```
gh stack checkout <pr-number | branch>
```

```bash
# By PR number (pulls from GitHub)
gh stack checkout 42

# By branch name (local only)
gh stack checkout feature-auth
```

When a PR number is provided (e.g. `123`), the command fetches the stack on GitHub, pulls the branches, and sets up the stack locally. If the stack already exists locally and matches, it switches to the branch.

> **⚠️ Agent warning:** If the local and remote stacks have different branch compositions, this command triggers an interactive conflict-resolution prompt that cannot be bypassed with a flag. To avoid this: run `gh stack unstack` first to remove the conflicting local stack, then retry `gh stack checkout <pr-number>`.

When a branch name is provided, the command resolves it against locally tracked stacks only. This is always safe for non-interactive use.

---

### Remove a stack — `gh stack unstack`

Tear down a stack so you can restructure it — remove a branch, reorder branches, rename branches, or make other large changes. After unstacking, use `gh stack init` to re-create the stack with the desired structure.

You must have a branch from the stack checked out locally. The command targets the active stack — the one that contains the currently checked out branch.

```
gh stack unstack [flags]
```

```bash
# Tear down the stack (locally and on GitHub), then rebuild
gh stack unstack
gh stack init --base main branch-2 branch-1 branch-3 # reordered

# Only remove local tracking (keep the stack on GitHub)
gh stack unstack --local
```

| Flag | Description |
|------|-------------|
| `--local` | Only delete the stack locally (keep it on GitHub) |

---

