STEP 1 — Gather context

Run the following commands to collect the information needed:
- `git rev-parse --abbrev-ref HEAD` — current branch
- `git remote get-url origin 2>/dev/null || echo "(no remote)"` — remote URL
- `git status` — working tree state
- `git diff --cached` — staged changes
- `git diff` — unstaged changes
- `git log --oneline -20` — recent commits (for message style reference)

---

STEP 2 — Guard: check current branch

If the current branch is `main` or `master`:

- If the remote URL contains `privacy-com` (e.g. `github.com/privacy-com/...`), output:

  > Aborted: refusing to commit directly to `<branch>`. Switch to a feature branch first.

  Then stop — do not proceed to any further steps.

- If the remote does NOT contain `privacy-com` (or there is no remote), continue — committing to main is allowed for personal/non-org repos.

---

STEP 3 — Review changes and plan commits

Understand what changed and — more importantly — *why* those changes exist (infer from context, filenames, and diff content).

Decide whether the changes belong in **one commit or multiple**. Split into multiple commits if the changes are logically independent (e.g. a bug fix and an unrelated refactor, or changes to separate subsystems). When in doubt, prefer splitting — a focused commit history is more useful than a catch-all.

For each planned commit, identify exactly which files/hunks belong to it.

---

STEP 4 — Stage and commit (repeat per commit)

For each commit in your plan:

1. Stage only the files/hunks for this commit. Use `git add <file>` for whole files, or `git add -p <file>` to stage individual hunks.

2. Write a commit message that explains *why* this change was made. Follow these rules:
   - Subject line: 50 chars or fewer, imperative mood, no trailing period
   - If a body is warranted (non-obvious motivation), add a blank line then a short paragraph
   - Do NOT mention file names in the subject unless the change is purely mechanical (rename, move)
   - Do NOT add "🤖 Generated with Claude Code" or co-author trailers — this command commits as the user

3. Run the commit using a HEREDOC. Do NOT pass `--no-verify`, `--no-gpg-sign`, `-n`, or any flag that bypasses hooks or signing. Do NOT use `--amend`.

```bash
git commit -m "$(cat <<'EOF'
<subject line>

<optional body>
EOF
)"
```

Repeat until all planned commits are done.

---

STEP 7 — Push

Check whether the current branch has a remote tracking branch:
```
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

- If a tracking branch exists: run `git push`
- If no tracking branch exists: run `git push -u origin <branch>`

Do NOT pass `--force`, `-f`, `--force-with-lease`, or any flag that overwrites remote history.
