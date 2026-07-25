# gh-stack workflows

Worked examples for each stack operation. Loaded on demand from `SKILL.md`.


### End-to-end: create a stack from scratch

```bash
# 1. Initialize a stack with the first branch
gh stack init -p feat auth
# → creates feat/auth and checks it out

# 2. Write code for the first layer (auth)
cat > auth.go << 'EOF'
package auth

func Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // verify token
        next.ServeHTTP(w, r)
    })
}
EOF

# 3. Stage and commit using standard git commands
git add auth.go
git commit -m "Add auth middleware"

# You can make multiple commits on the same branch
cat > auth_test.go << 'EOF'
package auth

func TestMiddleware(t *testing.T) {
    // test auth middleware
}
EOF
git add auth_test.go
git commit -m "Add auth middleware tests"

# 4. When you're ready for a new concern, add the next branch
gh stack add api-routes
# → creates feat/api-routes (prefix applied automatically — just pass the suffix)

# 5. Write code for the API layer
cat > api.go << 'EOF'
package api

func RegisterRoutes(mux *http.ServeMux) {
    mux.HandleFunc("/users", handleUsers)
}
EOF
git add api.go
git commit -m "Add API routes"

# 6. Add a third layer for frontend
gh stack add frontend
# → creates feat/frontend (just the suffix — prefix is automatic)

cat > frontend.go << 'EOF'
package frontend

func RenderDashboard(w http.ResponseWriter) {
    // calls the API endpoints from the layer below
}
EOF
git add frontend.go
git commit -m "Add frontend dashboard"

# ── Stack complete: feat/auth → feat/api-routes → feat/frontend ──

# 7. Push everything and create PRs (drafts by default)
gh stack submit --auto

# 8. Verify the stack
gh stack view --json
```

> **Shortcut:** If you prefer a faster flow, `gh stack add -Am "message" branch-name` combines staging, committing, and branch creation into one command. This is useful for single-commit layers but bypasses deliberate staging.

### Making mid-stack changes

This is a critical workflow for agents. When you're working on a higher layer and realize you need to change something in a lower layer (e.g., you're building frontend components but need to add an API endpoint), **navigate down to the correct branch, make the change there, and rebase**.

```bash
# You're on feat/frontend but need to add an API endpoint

# 1. Navigate to the API branch
gh stack down
# or: gh stack checkout feat/api-routes

# 2. Make the change where it belongs
cat > users_api.go << 'EOF'
package api

func handleGetUser(w http.ResponseWriter, r *http.Request) {
    // new endpoint the frontend needs
}
EOF
git add users_api.go
git commit -m "Add get-user endpoint"

# 3. Rebase everything above to pick up the change
gh stack rebase --upstack

# 4. Navigate back to where you were working
gh stack top
# or: gh stack checkout feat/frontend

# 5. Continue working — the API changes are now available
```

**Why this matters:** If you make API changes on the frontend branch, those changes will end up in the wrong PR. The API PR won't include them, and the frontend PR will have unrelated API diffs mixed in. Always put changes in the branch where they logically belong.

### Modify a mid-stack branch and sync

When you need to revisit a branch after the initial creation (e.g., responding to review feedback):

```bash
# 1. Navigate to the branch that needs changes
gh stack bottom
# or: gh stack checkout feat/auth
# or: gh stack checkout 42  (by PR number)

# 2. Make changes and commit
cat > auth.go << 'EOF'
package auth
// updated implementation
EOF
git add auth.go
git commit -m "Fix auth token validation"

# 3. Rebase everything above this branch
gh stack rebase --upstack

# 4. Push the updated stack
gh stack push
```

### Routine sync after merges

```bash
# Single command: fetch, rebase, push, sync PR state
gh stack sync

# Sync and automatically clean up local branches for merged PRs
gh stack sync --prune
```

> **Note for agents:** In non-interactive environments, the prune prompt is not shown. Use `--prune` explicitly to delete local branches for merged PRs.

### Squash-merge recovery

When a PR is squash-merged on GitHub, the original branch's commits no longer exist in the trunk history. `gh stack` detects this automatically and uses `git rebase --onto` to correctly replay remaining commits.

```bash
# After PR #1 (feat/auth) is squash-merged on GitHub:
gh stack sync
# → fetches latest, detects the merge, fast-forwards trunk
# → rebases feat/api-routes onto updated trunk (skips merged branch)
# → rebases feat/frontend onto feat/api-routes
# → pushes updated branches
# → reports: "Merged: #1"

# Verify the result
gh stack view --json
# → feat/auth shows "isMerged": true, "state": "MERGED"
# → feat/api-routes and feat/frontend show updated heads
```

If `sync` hits a conflict during this process, it restores all branches to their pre-rebase state and exits with code 3. See [Handle rebase conflicts](#handle-rebase-conflicts-agent-workflow) for the resolution workflow.

### Handle rebase conflicts (agent workflow)

```bash
# 1. Start the rebase
gh stack rebase

# 2. If exit code 3 (conflict):
#    - Parse stderr for conflicted file paths
#    - Read those files to find <<<<<<< / ======= / >>>>>>> markers
#    - Edit files to resolve conflicts
#    - Stage resolved files:
git add path/to/resolved-file.go

# 3. Continue the rebase
gh stack rebase --continue

# 4. If another conflict occurs, repeat steps 2-3

# 5. If unable to resolve, abort to restore everything
gh stack rebase --abort
```

### Parsing `--json` output

```bash
# Get stack state as JSON
output=$(gh stack view --json)

# Check if any branch needs a rebase, and rebase if so
needs_rebase=$(echo "$output" | jq '[.branches[] | select(.needsRebase == true)] | length')
if [ "$needs_rebase" -gt 0 ]; then
  echo "Branches need rebase, rebasing stack..."
  gh stack rebase
fi

# Get all open PR URLs
echo "$output" | jq -r '.branches[] | select(.pr.state == "OPEN") | .pr.url'

# Find merged branches
echo "$output" | jq -r '.branches[] | select(.isMerged == true) | .name'

# Get the current branch
echo "$output" | jq -r '.currentBranch'

# Check if the stack is fully merged (all branches merged)
echo "$output" | jq '[.branches[] | .isMerged] | all'
```

### Restructure a stack (remove a branch, reorder, or rename)

Use `unstack` to tear down the stack, make structural changes, then re-init:

```bash
# 1. Remove the stack (locally and on GitHub)
gh stack unstack

# 2. Make structural changes — e.g. delete a branch, reorder, rename
git branch -m old-branch-1 new-branch-1

# 3. Re-create the stack with the new structure
gh stack init --base main new-branch-1 new-branch-2 new-branch-3
```

---

