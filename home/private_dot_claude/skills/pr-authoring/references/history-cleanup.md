# Cleaning a branch's history

Follow these steps when `triage.sh metrics` reports `needs_history_cleanup=true` and the user
has confirmed the rewrite. `triage.sh` is the script beside this file.

1. Save a restore point with `REF=$(triage.sh backup)`, and tell the user
   `git reset --hard $REF` undoes everything.
2. Rebase onto `origin/<default>`. Resolve conflicts or hand them back; never
   `--skip` silently.
3. Save a second ref, `CHECKPOINT=$(triage.sh backup)`. The regroup must preserve this
   post-rebase tree, which differs from `$REF` whenever the rebase pulled in upstream work.
4. Propose the target commits in prose, each with a why-focused message. Fold a commit
   that reverses an earlier approach into the commit it corrects.
5. On confirmation, run `GIT_EDITOR=true GIT_SEQUENCE_EDITOR='cp <todo>' git rebase -i
   <base>`. The todo uses `fixup`, not `squash`, and an `exec git commit --amend -m ...`
   after each group, so no step opens an editor.
6. `triage.sh assert-tree-equal "$CHECKPOINT"` must exit 0. Otherwise stop, show its
   diff, and do not push.
7. Push with `git push --force-with-lease` after the user confirms. Never plain
   `--force`, never `--no-verify`.
