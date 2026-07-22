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
3. Propose a regrouping plan IN PROSE before the reorder/squash: the target
   semantic commits, which current commits fold into each, and a why-focused
   message per target (explain WHY, not just what — per the user's git
   convention). Fold any commit that reverses an earlier approach on the branch
   into the commit it corrects, so the reviewer never reads an undone approach.
4. On confirmation, execute the reorder/squash non-interactively:
   - Generate the rebase todo and drive it via
     `GIT_SEQUENCE_EDITOR='cp <todo-file>' git rebase -i <base>`, using `pick`
     for the commit leading each semantic group and `fixup` (NOT `squash`)
     for every commit folded into it — `fixup` discards the folded commit's
     message and never opens an editor, so the rebase can't pause for
     interactive input.
   - To set each resulting commit's final message, interleave an
     `exec git commit --amend -m "<message>"` line in the generated todo
     immediately after each group's picks/fixups. This sets messages
     deterministically with no editor involved.
   - Explicitly set a non-interactive editor as defense in depth (e.g.
     `GIT_EDITOR=true`) so no step can block waiting on an editor.
   - On conflict, resolve or hand back to the user; never `git rebase --skip`
     silently — the backup ref from step 1 remains the restore point.
5. `bash references/triage.sh assert-tree-equal "$REF"` — if it exits
   non-zero, STOP, do NOT push, show the user the reported diff and the
   restore command. This is a hard gate.

Safety constraints throughout: never a plain `git push --force` (a later step
uses `--force-with-lease`), never `--no-verify`, never bypass commit signing.

## Step 3 — Split into a stack (only if `split_worthy` and user opts in)

The primary path is plain git + core `gh` — no extension required, since both
are already load-bearing for this skill. Native stacking support is an
optional enhancement layered on top, not a dependency.

1. Take the independent file-groups identified in Step 1 and order them by
   dependency: leaf concerns first, the integration/glue group last. Present
   the proposed group→branch mapping and ASK before creating any
   branches or PRs.
2. On confirmation, build the stack with plain git + `gh`:
   - For each group in dependency order, create a branch off the *previous*
     group's branch (the first group branches off the default branch), move
     that group's changes onto it, and commit.
   - Open each PR with `gh pr create --base <previous-branch> --draft`, so
     the PR's own base ref encodes its position in the chain.
   - Write a small stack table into each PR's body (position/order plus
     links to the other PRs in the stack) so reviewers can see the full
     chain from any one PR — this linkage lives in the PR body itself,
     independent of any hosted stacking feature.
3. Optional enhancement — native/official stacking: if a `gh-stack`
   extension is installed (`gh extension list` shows `gh stack`) and it is
   enabled for this repo, the skill MAY use it instead to create/link the
   stack. As of mid-2026, GitHub's official `github/gh-stack` tooling and the
   `PullRequestStack` API are private-preview / SKU-gated with no public
   creation mutation, so treat this path as best-effort only — it must
   degrade to the base-chaining approach above whenever the extension is
   absent, disabled, or its mutation is unavailable.
4. If `gh` is unavailable, or the user declines the split, skip Step 3
   cleanly and proceed with the single PR to Step 4.

## Step 4 — Curate (always)

1. Detect a `pr-curator` agent or skill. If absent, note it and skip
   curation.
2. Invoke `pr-curator` to refresh the PR description and post numbered
   reading-order review comments.
3. Ensure the PR is in draft mode (`gh pr ready --undo` if needed, or create
   with `--draft`).

## Push

- Push rewritten history with `git push --force-with-lease` — NEVER plain
  `--force`, NEVER `--no-verify`, never bypass commit signing. Confirm with
  the user first.
- After pushing, restate the backup ref and the exact restore command
  (`git reset --hard <REF>`).

## Degradation summary

- No `gh` auth → skip PR-side actions (curate/push); report the local result
  only.
- No stacking capability, or the user declines → fall back to the
  base-chaining approach in Step 3, or skip Step 3 entirely; the single PR
  proceeds.
- No `pr-curator` → skip Step 4's curation.
- Large generated-file diffs detected → mention a `.gitattributes`
  `linguist-generated` recommendation; do not modify `.gitattributes`.
