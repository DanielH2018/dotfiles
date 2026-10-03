# Retiring a landed worktree

`worktree-landed.sh` blocks a session's Stop once, when the worktree it is standing in holds
nothing but work that has already landed. The block is one line: it names the procedure below
that fits the merge shape, and the values for `<primary>`, `<tree>` and `<branch>`. `<tree>` is
relative to `<primary>`, which is how `git -C <primary>` resolves it. This file
carries the steps and why each one is shaped the way it is. The block text is printed to the
user verbatim, which is why the steps live here rather than in it.

## The procedure

Run the steps in order and stop at the first one that fails. If work remains in the tree (a
deploy, a verification), keep the worktree and say so in one line instead. Either way, reply in
one line: retired, or the step that failed.

### Ancestor procedure

1. ExitWorktree with action "remove". Never discard_changes. If ExitWorktree answers that there
   is no active EnterWorktree session, that is not a failure: run
   `git -C <primary> worktree remove <tree>` instead. Unlock the tree first if git reports it is
   locked. Never --force.
2. `git -C <primary> branch -d <branch>`, BEFORE the pull below, and again AFTER the pull if it
   refuses. Never -D on this path.
3. `git -C <primary> pull --ff-only`. In a repo with a pull-based deployer, trigger a deploy
   tick instead.

### Squash procedure

1. ExitWorktree with action "keep". Action "remove" WILL refuse here ("N commits on
   <branch>"). Never discard_changes. If ExitWorktree answers that there is
   no active EnterWorktree session, that is not a failure: go on to step 2.
2. `git -C <primary> worktree remove <tree>`. Unlock the tree first if git reports it is
   locked. Never --force.
3. `git -C <primary> branch -d <branch>`, and only if that refuses, the capital-D form.
4. `git -C <primary> pull --ff-only`. In a repo with a pull-based deployer, trigger a deploy
   tick instead.

## Why the session has to do this, not a sweeper

`prune-worktrees.py` reaps abandoned trees at session start, which is always one session late
for the tree the merging session is standing in — a process cannot delete its own cwd, and
while the session lives its lock reads as in-use. ExitWorktree can, because the harness leaves
the directory before removing it. So the cleanup has to be asked for in-session, and a Stop
hook is the only place that fires after the merge and before the session goes away.

`prune-worktrees.py` is the backstop, not the plan. It reaps trees, and it deletes their
branches with `-d`, plus orphaned session branches. It uses `-D` only on a branch whose
exact tip GitHub says a merged PR came from. It runs one session late for the tree the
merging session stands in. Like this hook, it keeps a tree while any live process has its
cwd inside it, so it does not cut off a detached landing that outlives its session.

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

## Sessions a script launched into their tree

ExitWorktree acts only on a tree that `EnterWorktree` created in the same session. A session a
script started inside its worktree, such as a Remote Control bridge session, gets "No-op:
there is no active EnterWorktree session to exit" for either action. The block used to read
that reply as the failed first step, so the session stopped with its tree still registered.
The server repo's transcripts from 2026-09-19 to 2026-09-26 hold 45 such no-ops (dotfiles#683).
The block therefore reads the no-op as a skipped step. On the ancestor path the session runs
the `git worktree remove` that ExitWorktree would have run. On the squash path it goes on to
step 2, which already removes the tree by hand. No lock of the session's own stands in the way,
because a launcher-created tree carries the launcher's lock or none.

A server fan-out worker gets no block at all. Its orchestrator's `fanout_place.py clean`
retires the tree once the PR lands, and `status` reads `.fanout/report.json` from the tree
until then. The hook recognises such a tree by the `.fanout/brief.md` its launcher writes.

## A tree a detached process still runs from

A landed tree can still be in use. A detached `land.sh` keeps running from the tree after the
merge: it waits on CI, ticks the deployer and runs scripts from the tree. On 2026-10-01 two
server landings died that way when a session followed the block and removed the tree
(dotfiles#747, dotfiles#748). So the hook stays silent, and writes no stamp, while any live
process outside the session has its cwd inside the tree. It asks at a later Stop, once that
process has exited.

The session's own processes do not count, because the session and its MCP servers stand in
the tree too. The hook treats as the session's own every process descended from itself or
from an ancestor whose cwd is inside the tree. A detached landing reparents to init, so it
is not the session's own. A background job the session started without detaching is, and the
hook does not protect it: wait for that job before you retire the tree.

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
