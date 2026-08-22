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
fi

: >"$STAMP" 2>/dev/null

jq -n --arg branch "$BRANCH" --arg landed "$LANDED_AS" --arg primary "$PRIMARY" --arg path "$TOPLEVEL" '{
  decision: "block",
  reason: (
    "This session'"'"'s worktree is finished with: \($branch) is clean and \($landed), " +
    "so nothing here exists only on disk.\n\n" +
    "Clean it up now — this is a standing instruction from the user'"'"'s config, not " +
    "something to ask about:\n" +
    "- If this session created the worktree with EnterWorktree, call " +
    "ExitWorktree with action \"remove\". Do NOT pass discard_changes: if that tool " +
    "refuses, it has found work this hook could not see, and the refusal is the " +
    "correct outcome — report it and stop.\n" +
    "- If ExitWorktree reports no active worktree session, it cannot act here. Say so " +
    "in one line and stop: prune-worktrees.py removes \($path) at the next session " +
    "start, once this session'"'"'s lock owner is gone.\n" +
    "- Then, and only after leaving the worktree, bring the primary checkout up to " +
    "date so the next session and any deploy read the merged tree: " +
    "git -C \($primary) pull --ff-only. Where the repo has a deploy lock, take it " +
    "first (in DanielH2018/server: flock /var/lock/server-git-tree.lock). If the " +
    "primary is on another branch, is dirty, or the fast-forward refuses, leave it " +
    "alone and say so in one line — never merge, reset or stash it.\n\n" +
    "Then finish your reply. Do not start new work. If there is still work to do here " +
    "(a deploy to run, a verification to make), say so and keep the worktree — this " +
    "fires once per worktree and will not ask again."
  )
}'
