#!/bin/bash
# Stop hook: when this session's worktree holds nothing but landed work, say so and ask
# for it to be cleaned up now rather than leaving it for the next session's sweeper.
#
# prune-worktrees.py reaps abandoned trees at session start, which is always one session
# late for the tree the merging session is standing in: a process cannot delete its own
# cwd, and while the session lives its lock reads as in-use. The harness can, though —
# ExitWorktree leaves the directory and removes it — so the cleanup has to be asked for
# in-session, and a Stop hook is the only place that fires after the merge and before the
# session goes away.
#
# Everything here is local: no fetch, no ls-remote. The merge that makes a branch an
# ancestor of origin/<default> happens through `gh pr merge` or `bin/land` in this same
# session, and both update the local ref as a side effect. A stale ref therefore makes
# this hook stay quiet and leaves the tree to the sweeper — the same fail-quiet direction
# prune-worktrees.py takes, and worth more than a per-turn network call.
#
# A squash or rebase merge rewrites the commits, so the branch tip is not an ancestor of
# the default branch and the test above says nothing. That is not rare here: DanielH2018/
# server allows both (`gh repo view` reports squashMergeAllowed and rebaseMergeAllowed),
# and PR #317 — squash-merged as 78358ddb — is why this fallback exists.
#
# The fallback asks GitHub whether a PR with this branch as its head is merged, which is
# provenance rather than a guess. `git cherry`, which prune-worktrees.py falls back to, is
# not: patch-id equality is why that sweeper REPORTS instead of reaping, and a Stop hook
# can only block, so handing a session something a person has to adjudicate is worse than
# staying quiet. The gh call is the one network call in this file. It is reached only when
# the free local test has already failed, it is timeout-bounded, and every failure — no gh,
# no auth, no GitHub remote, an API error — falls through to silence.
#
# Cleanup is three things, not one: leave the worktree, delete the branch it left behind,
# fast-forward the primary checkout. The block text asks for the deletion twice, once on
# each side of the pull, because the two merge shapes need opposite orders and the hook
# cannot tell which one is coming. `git branch -d` accepts a branch merged into HEAD OR
# its upstream. A squash merge satisfies only the upstream half, via a stale
# refs/remotes/origin ref that the pull prunes — fetch.prune is on here. A fast-forward or
# merge-commit land satisfies only the HEAD half, and the tip does not reach the primary's
# HEAD until that same pull. Observed both on 2026-08-22: `bin/land` had already pruned the
# tracking ref, so `-d` refused before the pull and succeeded after it.
#
# THE TWO CASES NEED DIFFERENT INSTRUCTIONS, which is why the block text below is built in
# two halves rather than written once.
#
# Where the tip is an ancestor, ExitWorktree removes the tree itself and there is nothing to
# work around. Where a squash or rebase rewrote the commits, ExitWorktree REFUSES — it tests
# reachability, so it reports "N commits on <branch>" for a branch whose work is provably
# landed, indistinguishably from one holding real unlanded work. Until 2026-08-22 this hook
# told the session to accept that refusal and stop, which stranded every squash-merged tree
# it fired on: two in one session, both still on disk after being told to clean up.
#
# The session can finish the job by hand, and this hook is exactly what makes that safe. It
# has already confirmed a merged pull request whose head is this exact tip — provenance, not
# a content guess — so `-D` here is not overriding a safety check, it is supplying the fact
# the check could not reach. Measured, in this order, on 2026-08-22:
#   - ExitWorktree "keep" returns the session to the primary, RELEASES the worktree lock, and
#     lifts the isolation guard that refuses `git -C <primary>` from inside a worktree. All
#     three matter; the git steps below fail without it.
#   - `git worktree remove` then succeeds with no unlock needed.
#   - The branch cannot be deleted BEFORE the worktree is removed ("used by worktree at ...").
#   - `-d` refused once origin/<branch> was pruned, and `-D` succeeded.
#
# prune-worktrees.py is the backstop, not the plan: it reaps trees at the next session start
# (its is_merged learned the squash case on 2026-08-22), but it deletes no branches — there is
# no branch sweep in it, despite what an earlier version of this comment claimed.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# One nudge per stop cascade: if the block already fired once, let the session stop.
[ "$(hook_field '.stop_hook_active // false')" = "true" ] && exit 0

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# A *linked* worktree has a per-worktree git dir distinct from the shared common dir.
# Resolve both physically so a symlinked path can't fool the comparison.
GIT_DIR_RAW=$(git rev-parse --git-dir 2>/dev/null) || exit 0
COMMON_RAW=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
GIT_DIR_ABS=$(cd "$GIT_DIR_RAW" 2>/dev/null && pwd -P) || exit 0
COMMON_ABS=$(cd "$COMMON_RAW" 2>/dev/null && pwd -P) || exit 0
[ "$GIT_DIR_ABS" != "$COMMON_ABS" ] || exit 0

# Ask once per worktree, ever. stop_hook_active only suppresses a re-fire inside a single
# stop cascade, so without this the same landed-and-clean state re-blocks at the end of
# every later turn — and merging is often not the end of the work here (merge, deploy,
# verify), which would evict a session from its worktree mid-task and then nag about it.
# The stamp lives in the per-worktree git dir, so it dies with the tree it refers to.
STAMP="$GIT_DIR_ABS/claude-landed-nudged"
[ -f "$STAMP" ] && exit 0

# Only session worktrees are ours to comment on. One the operator made by hand elsewhere
# is not, however landed it looks.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
TOPLEVEL=$(cd "$TOPLEVEL" 2>/dev/null && pwd -P) || exit 0
PRIMARY=$(dirname "$COMMON_ABS")
case "$TOPLEVEL" in
  "$PRIMARY/.claude/worktrees/"*) ;;
  *) exit 0 ;;
esac

# Uncommitted work means not done, whatever the branch says. A `git status` that fails is
# usually another session mid-write on the shared index — treat that as work in progress
# too, never as clean.
STATUS=$(git status --porcelain 2>/dev/null) || exit 0
[ -n "$STATUS" ] && exit 0

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  exit 0  # detached: no branch to have landed
fi

# The branch must have been pushed at some point. Without this, a worktree created a
# moment ago — clean, sitting exactly on the default branch, no commits yet — reads as
# "landed" and the session gets told to delete the workspace it just opened.
git config --get "branch.$BRANCH.merge" >/dev/null 2>&1 || exit 0

DEFAULT=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
if [ -z "$DEFAULT" ]; then
  for GUESS in origin/main origin/master; do
    git rev-parse --verify --quiet "$GUESS" >/dev/null 2>&1 && DEFAULT="$GUESS" && break
  done
fi
[ -z "$DEFAULT" ] && exit 0

# Landed: every commit here is already in the default branch, so nothing is recoverable
# only from this directory.
LANDED_AS="every commit is already in $DEFAULT"
REWRITTEN=0
if ! git merge-base --is-ancestor HEAD "$DEFAULT" 2>/dev/null; then
  # The tip may have been rewritten by a squash or rebase merge. Before trusting GitHub's
  # answer, require that the tip is the commit that was pushed: a merged PR says nothing
  # about a commit made in this worktree afterwards. A deleted upstream ref — the usual
  # state after a merge with branch deletion — leaves nothing to disagree with.
  UPSTREAM=$(git rev-parse --verify --quiet '@{upstream}' 2>/dev/null)
  if [ -n "$UPSTREAM" ] && [ "$UPSTREAM" != "$(git rev-parse HEAD 2>/dev/null)" ]; then
    exit 0
  fi

  GH="${GH_BIN:-gh}"
  command -v "$GH" >/dev/null 2>&1 || exit 0
  MERGED=$(timeout 5 "$GH" pr list --head "$BRANCH" --state merged --limit 1 \
    --json number --jq 'length' 2>/dev/null) || exit 0
  [ "$MERGED" = "1" ] || exit 0
  LANDED_AS="its pull request is merged into $DEFAULT"
  REWRITTEN=1
fi

# The removal step, which differs by merge shape — see the two-cases note in the header.
if [ "$REWRITTEN" = "0" ]; then
  REMOVAL="- If this session created the worktree with EnterWorktree, call ExitWorktree with \
action \"remove\". Do NOT pass discard_changes: the tip is an ancestor of $DEFAULT, so a \
refusal here means real work this hook could not see — report it and stop.
- If ExitWorktree reports no active worktree session, it cannot act here. Say so in one line \
and stop: prune-worktrees.py removes $TOPLEVEL at the next session start, once this session's \
lock owner is gone.
- Then delete the branch, which removing the worktree leaves behind: \
git -C $PRIMARY branch -d $BRANCH. Try it BEFORE the pull below AND, if it refuses, once more \
AFTER the pull — -d accepts a branch merged into HEAD or into its upstream, and a \
fast-forward or merge-commit land does not put the tip in the primary's own HEAD until that \
pull brings it down. Never -D on this path: with the tip an ancestor, -d has every fact it \
needs, so a refusal here is telling you something. If -d refuses both times, leave the branch \
and say so in one line — prune-worktrees.py reports it for a person to settle."
else
  REMOVAL="- ExitWorktree with action \"remove\" WILL refuse here, reporting \"N commits on \
$BRANCH\". That is not a finding: the merge rewrote the commits, so the tool's reachability \
test cannot see work that provably landed. Do NOT pass discard_changes to argue with it. \
Retire the tree by hand instead, in this order:
    1. ExitWorktree with action \"keep\" — this returns the session to $PRIMARY, releases \
the worktree lock, and lifts the isolation guard that refuses git commands aimed at the \
primary from inside a worktree. The steps below fail without it.
    2. git -C $PRIMARY worktree remove $TOPLEVEL — and if it reports the tree is locked, \
run git -C $PRIMARY worktree unlock $TOPLEVEL first. Never --force: git's own refusal on a \
tree holding uncommitted files is the backstop that makes this safe.
    3. git -C $PRIMARY branch -d $BRANCH, and only if that refuses, the capital-D form of the \
same command. Capital D is correct HERE and nowhere else: this hook confirmed a merged pull \
request whose head is this exact tip, which is the fact -d can no longer reach once the \
tracking ref has been pruned. The branch will not go before step 2 — git holds it while a \
worktree uses it.
  Stop at the first step that fails and say which one. A half-retired tree is for \
prune-worktrees.py to finish, not for you to force past.
- If ExitWorktree reports no active worktree session, do steps 2 and 3 anyway — they do not \
need it — then say so in one line."
fi

: >"$STAMP" 2>/dev/null

jq -n --arg branch "$BRANCH" --arg landed "$LANDED_AS" --arg primary "$PRIMARY" \
      --arg path "$TOPLEVEL" --arg removal "$REMOVAL" '{
  decision: "block",
  reason: (
    "This session'"'"'s worktree is finished with: \($branch) is clean and \($landed), " +
    "so nothing here exists only on disk.\n\n" +
    "Clean it up now — this is a standing instruction from the user'"'"'s config, not " +
    "something to ask about:\n" +
    $removal + "\n" +
    "- Then bring the primary checkout up to date so the next session and any deploy " +
    "read the merged tree: git -C \($primary) pull --ff-only. Where the repo has a " +
    "deploy lock, take it first (in DanielH2018/server: flock " +
    "/var/lock/server-git-tree.lock). If the primary is on another branch, is dirty, or " +
    "the fast-forward refuses, leave it alone and say so in one line — never merge, " +
    "reset or stash it. Where a pull-based deployer derives what to deploy from " +
    "local..origin (DanielH2018/server does), fast-forwarding by hand cancels the " +
    "deploys those commits were due — trigger a deploy tick instead, which merges and " +
    "deploys in one step.\n\n" +
    "Then finish your reply. Do not start new work. If there is still work to do here " +
    "(a deploy to run, a verification to make), say so and keep the worktree — this " +
    "fires once per worktree and will not ask again."
  )
}'
