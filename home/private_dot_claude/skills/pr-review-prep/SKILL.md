---
name: pr-review-prep
description: Use before requesting review on a feature branch — measure the PR's reviewability, linearize and re-narrate commit history, optionally split into a stack, and run the PR curator. Triggers on "clean up before review", "get this PR review-ready", "make this diff reviewable", or /pr-review-prep.
---

# pr-review-prep

Make a feature branch review-ready. Repo-agnostic; degrades gracefully when
`gh`, `gh-stack`, or `pr-curator` are absent.

All deterministic git math and safety checks live in `references/triage.sh`
in this skill's directory. Run its subcommands from the skill directory, e.g.
`bash references/triage.sh <cmd>` (or resolve the skill directory at runtime
and invoke `bash <skill-dir>/references/triage.sh <cmd>` from elsewhere).

## Preconditions (run first, in order)

1. `bash references/triage.sh guard-branch` — if it exits non-zero, STOP and
   report; never proceed on a protected branch.
2. Confirm a clean working tree (`git status --porcelain` empty). If dirty,
   STOP and ask the user to commit or stash.

## Step 1 — Reviewability triage (always)

1. Determine independent file-groups yourself (judgment): group changed files
   in `merge-base(origin/<default>, HEAD)..HEAD` by top-level module/dir,
   mapping test files back to the module they cover; count groups that share
   no edited files and don't reference each other's changed symbols.
2. Run `bash references/triage.sh metrics <group-count>`.
3. Present the review-cost readout to the user, e.g.:
   `Review cost: <files> files · +<add>/−<del> · <commits> real commits (+<merges> merge, +<fixups> fixup) · <groups> separable concerns`
   followed by the recommendation implied by `needs_history_cleanup` and
   `split_worthy`.
4. These flags GATE Steps 2 and 3. Recommendations are advisory; the user
   confirms before any rewrite.
