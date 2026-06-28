STEP 1 — Gather context

Run the following commands to collect the information needed:
- `git rev-parse --abbrev-ref HEAD` — current branch
- `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'` — default branch
- `git status --short` — uncommitted changes
- `git log --oneline <default-branch>..HEAD` — commits on this branch vs default
- `git diff <default-branch>...HEAD` — diff vs default
- `gh pr list --limit 10 --state all --json title,body --jq '.[] | "Title: \(.title)\nBody: \(.body)\n---"' 2>/dev/null` — recent PRs for style reference
- `gh pr view --json url,state 2>/dev/null || echo "none"` — existing PR for this branch

---

STEP 2 — Guard: check current branch

If the current branch matches the default branch, or is `main` or `master`, output:

> Aborted: cannot open a PR from the default branch. Switch to a feature branch first.

Then stop — do not proceed to any further steps.

---

STEP 3 — Guard: check for existing PR

If the existing PR check returned a URL and state is `OPEN`, output:

> PR already open: <url>

Then stop.

---

STEP 4 — Guard: uncommitted changes

If there are unstaged or staged changes, output:

> Warning: you have uncommitted changes. Run /git-commit-and-push first, or they will not be included in this PR.

Then stop. Do not proceed — an incomplete commit state makes the PR misleading.

---

STEP 5 — Push branch if needed

Check whether the branch has a remote tracking branch:
```
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

- If no tracking branch: run `git push -u origin <branch>`
- If tracking branch exists: no action needed

Do NOT pass `--force`, `-f`, or any flag that overwrites remote history.

---

STEP 6 — Draft PR title and body

Review the commits, diff, and recent PRs. Use the recent PRs to match the repo's style (tone, section headers, level of detail).

**Title**: one concise line explaining *why* this PR exists (not just what changed). Match the style of recent PR titles — imperative or noun phrase, whichever the repo favors. Keep it under 72 characters.

**Body**: write a markdown description following the repo's apparent structure. If no clear pattern exists, use:

```
## Summary
<1-3 bullet points covering what changed and why>

## Test plan
<bulleted checklist of how to verify correctness>
```

Do NOT add "🤖 Generated with Claude Code" or co-author trailers.

---

STEP 7 — Create PR

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)" --base <default-branch>
```

After the PR is created, output the PR URL.
