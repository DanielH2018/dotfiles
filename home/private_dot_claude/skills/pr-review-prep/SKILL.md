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

## Step 2 — Clean up history (only if needs_history_cleanup and user confirms)

1. `REF="$(bash references/triage.sh backup)"` — create the backup ref. Tell
   the user: "Backed up to `<REF>`; restore with `git reset --hard <REF>`."
2. `git rebase origin/<default>` (use `bash references/triage.sh
   default-branch` for `<default>`) to linearize and drop merge commits. If
   conflicts arise, resolve or hand back to the user; never `--skip` silently.
3. Propose a regrouping plan IN PROSE before touching anything: the target
   semantic commits, which current commits fold into each, and a why-focused
   message per target (explain WHY, not just what — per the user's git
   convention). Fold any commit that reverses an earlier approach on the branch
   into the commit it corrects, so the reviewer never reads an undone approach.
4. On confirmation, execute the reorder/squash non-interactively: write the
   rebase todo to a temp file and drive `git rebase -i` via
   `GIT_SEQUENCE_EDITOR='cp <todo-file>' git rebase -i <base>`, supplying
   pre-written messages with `-c core.editor=...` or `git commit --amend`.
5. `bash references/triage.sh assert-tree-equal "$REF"` — if it exits
   non-zero, STOP, do NOT push, show the user the reported diff and the
   restore command. This is a hard gate.

Safety constraints throughout: never a plain `git push --force` (a later step
uses `--force-with-lease`), never `--no-verify`, never bypass commit signing.
