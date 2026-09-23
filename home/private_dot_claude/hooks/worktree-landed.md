# Retiring a landed worktree

`worktree-landed.sh` blocks a session's Stop once, when the worktree it is standing in holds
nothing but work that has already landed. The block text carries the commands; this file
carries why each one is shaped the way it is. Read it when a step refuses, or before you
reach for a flag the block told you not to pass.

## Why the session has to do this, not a sweeper

`prune-worktrees.py` reaps abandoned trees at session start, which is always one session late
for the tree the merging session is standing in — a process cannot delete its own cwd, and
while the session lives its lock reads as in-use. ExitWorktree can, because the harness leaves
the directory before removing it. So the cleanup has to be asked for in-session, and a Stop
hook is the only place that fires after the merge and before the session goes away.

`prune-worktrees.py` is the backstop, not the plan. It reaps trees, but it deletes **no**
branches — there is no branch sweep in it.

## The two merge shapes need opposite orders

The hook picks one of two procedures from what it could prove, and they are not
interchangeable.

**Ancestor** — every commit is already in the default branch. ExitWorktree removes the tree
itself; there is nothing to work around. A refusal here means real work the hook could not
see, so report it and stop rather than arguing with `discard_changes`.

**Squash or rebase** — the merge rewrote the commits, so the tip is not an ancestor and the
reachability test says nothing. The hook falls back to asking GitHub for the head commit of
every merged PR opened from this branch name, and requires one of them to equal this tip.
The SHA is what makes that provenance rather than a guess: a branch name is reused freely
here, so a merged PR under the same name can belong to work that has nothing to do with what
is on disk. `DanielH2018/server` allows both merge shapes, and PR #317 — squash-merged as
`78358ddb` — is why the fallback exists.

## Why the branch deletion moves

`git branch -d` accepts a branch merged into HEAD **or** into its upstream, and the two merge
shapes satisfy opposite halves:

- A squash merge satisfies only the upstream half, through a stale `refs/remotes/origin` ref
  that the pull prunes — `fetch.prune` is on here.
- A fast-forward or merge-commit land satisfies only the HEAD half, and the tip does not reach
  the primary's own HEAD until that pull brings it down.

That is why the ancestor procedure tries `-d` on both sides of the pull. Observed on
2026-08-22: `bin/land` had already pruned the tracking ref, so `-d` refused before the pull and
succeeded after it.

**`-D` is correct in the squash procedure and nowhere else.** There, the hook has already
confirmed a merged pull request whose head is this exact tip, so `-D` is not overriding a
safety check — it is supplying the fact `-d` can no longer reach once the tracking ref is
gone. In the ancestor case `-d` has every fact it needs, so a refusal is telling you
something: leave the branch and say so.

## Why the squash procedure removes the tree by hand

ExitWorktree tests reachability, so `action: "remove"` reports `N commits on <branch>` for a
branch whose work provably landed — indistinguishably from one holding real unlanded work.
Until 2026-08-22 the block told the session to accept that refusal and stop, which stranded
every squash-merged tree it fired on: two in one session, both still on disk after being told
to clean up.

The hand path works, and the order was measured on 2026-08-22:

- `ExitWorktree` with `action: "keep"` returns the session to the primary, **releases the
  worktree lock**, and lifts the isolation guard that refuses `git -C <primary>` from inside a
  worktree. All three matter; the git steps fail without it.
- `git worktree remove` then succeeds with no unlock needed.
- The branch cannot be deleted **before** the worktree is removed (`used by worktree at ...`).
- `-d` refused once `origin/<branch>` was pruned, and `-D` succeeded.

**Never `--force` on `git worktree remove`.** Git's refusal on a tree holding uncommitted files
is the backstop that makes the whole procedure safe.

## Why the primary checkout gets a pull, and when it must not

The next session and any deploy read the primary checkout, so a merged tree that never reaches
it is a merge nobody applied. `--ff-only` is the whole point: if the primary is dirty, on
another branch, or the fast-forward refuses, leave it alone and say so — never merge, reset or
stash it.

Two repo-specific cautions:

- Where a deploy lock exists, take it first. In `DanielH2018/server` that is
  `flock /var/lock/server-git-tree.lock`.
- Where a **pull-based deployer derives what to deploy from `local..origin`**
  (`DanielH2018/server` does), fast-forwarding by hand cancels the deploys those commits were
  due. Trigger a deploy tick instead, which merges and deploys in one step.
