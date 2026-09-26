#!/bin/bash
# gen-hooks: register
#   event: Stop
#   timeout: 10
#   order: 40
# the session's own worktree is the one prune-worktrees.py can never reap: while
# the session lives it holds the lock and stands in the directory, so the sweeper
# is always a session late for it. This asks for the cleanup in-session instead,
# once the branch is an ancestor of origin/HEAD and the tree is clean. It asks
# once per worktree (a stamp in the per-worktree git dir): merging is often not
# the end of the work here, and a hook that re-blocked every turn would evict a
# session mid-deploy and then nag about it. Local refs
# only -- the merge that makes that true runs in this same session and updates
# them, so no fetch is needed and a stale ref just falls through to the sweeper.
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
# The fallback asks GitHub for the head COMMIT of every merged PR opened from this branch
# name, and requires one of them to be this exact tip. That is provenance rather than a
# guess. A name match alone is not: names are reused, and the count this used to take was
# enough to authorise `-D`. `git cherry`, which prune-worktrees.py falls back to, is
# not: patch-id equality is why that sweeper REPORTS instead of reaping, and a Stop hook
# can only block, so handing a session something a person has to adjudicate is worse than
# staying quiet. The lookup is `claude_worktree.forge_says_merged`, the same one
# prune-worktrees.py and the server repo's pruner use, run here as
# `claude_worktree.py forge-merged`. It is the one network call in this file. It is reached
# only when the free local test has already failed, it is timeout-bounded, and every
# failure — no module, no gh, no auth, no GitHub remote, an API error — falls through to
# silence.
#
# Cleanup is three things, not one: leave the worktree, delete the branch it left behind,
# fast-forward the primary checkout. THE TWO MERGE SHAPES NEED DIFFERENT ORDERS, which is why
# the block text below is built in two halves rather than written once. Why each half is
# ordered the way it is — why `-d` is tried on both sides of the pull, why `-D` is correct in
# the squash half and nowhere else, why ExitWorktree refuses a squash-merged tree, why
# `--force` is never the answer, and what prune-worktrees.py does and does not sweep — is in
# worktree-landed.md beside this script. That file is the block text's own reference, so it is
# the one place to change when any of it is re-measured; do not restate it here.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
# The one network call below goes through run_bounded like every other hook child (#581). A
# missing library is a broken install: say so and exit 1, which the harness reports as a
# non-blocking hook error. Staying silent would read exactly like "nothing has landed".
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  printf 'worktree-landed: cannot load %s; the landed-worktree check did not run\n' \
    "$RUN_BOUNDED_PATH" >&2
  exit 1
fi
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

# A server fan-out worker's tree belongs to its orchestrator: `fanout_place.py clean`
# removes it once the PR lands, and `status` reads `.fanout/report.json` from it until then.
# The launcher writes `.fanout/brief.md` into every worker tree, so its presence is the tell.
[ -e "$TOPLEVEL/.fanout/brief.md" ] && exit 0

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

  # Ask whether a merged PR's HEAD COMMIT is this tip, not whether one exists for the
  # name. A branch NAME is not evidence that this tip merged: names are reused freely, and
  # counting matches authorised `-D` — the one destructive step in the squash procedure —
  # on the strength of a string. The upstream test above catches the common shape of that
  # (a tip that moved after the push), but not the shape that matters: after a merge with
  # branch deletion `@{upstream}` no longer resolves, so nothing is left to disagree with.
  # `forge_says_merged` compares SHAs, and its docstring has the rest. GH_BIN reaches it
  # through the environment.
  CW_HOME="${CLAUDE_WORKTREE_HOME:-$HOME/.local/share/claude-worktree}"
  [ -f "$CW_HOME/claude_worktree.py" ] || exit 0
  command -v python3 >/dev/null 2>&1 || exit 0
  HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
  [ -n "$HEAD_SHA" ] || exit 0
  # Exit 0 is a confirmed merge. Every other status falls through to silence, as the
  # header says.
  run_bounded 5 65536 -- python3 "$CW_HOME/claude_worktree.py" forge-merged \
    "$BRANCH" "$HEAD_SHA"
  if [ "$RB_STATUS" != ok ] || [ "$RB_EXIT" -ne 0 ]; then exit 0; fi
  LANDED_AS="its pull request is merged into $DEFAULT"
  REWRITTEN=1
fi

# Where the reasoning for every step below lives. The block text carries the commands and
# the caveats that change what you type — nothing else. It is rendered verbatim into the
# session log, where a paragraph of rationale is a paragraph of noise on every landed
# worktree. Resolved next to this script so a worktree copy points at its own doc rather
# than the deployed one.
DOC_DIR=$(cd "${BASH_SOURCE[0]%/*}" 2>/dev/null && pwd -P) || DOC_DIR=""
DOC="${DOC_DIR:+$DOC_DIR/}worktree-landed.md"

# The removal step, which differs by merge shape — see the two-cases note in the header and
# the "two merge shapes" section of the doc.
#
# A session a script launched into its tree (a Remote Control bridge session, say) gets
# ExitWorktree's "no active EnterWorktree session" no-op instead. That reply is a skipped
# step, not a failure, so each half names the `git worktree remove` that retires the tree
# without the tool.
NO_OP="If ExitWorktree answers that there is no active EnterWorktree session, that is not a \
failure:"
if [ "$REWRITTEN" = "0" ]; then
  PULL_STEP=3
  REMOVAL="  1. ExitWorktree with action \"remove\". Never discard_changes. $NO_OP run \
git -C $PRIMARY worktree remove $TOPLEVEL instead — unlock it first if it reports the tree is \
locked. Never --force.
  2. git -C $PRIMARY branch -d $BRANCH — BEFORE the pull below, and again AFTER the pull if \
it refuses. Never -D on this path."
else
  PULL_STEP=4
  REMOVAL="  1. ExitWorktree with action \"keep\". Action \"remove\" WILL refuse here \
(\"N commits on $BRANCH\"). Never discard_changes. $NO_OP go on to step 2.
  2. git -C $PRIMARY worktree remove $TOPLEVEL — unlock it first if it reports the tree is \
locked. Never --force.
  3. git -C $PRIMARY branch -d $BRANCH, and only if that refuses, the capital-D form."
fi

: >"$STAMP" 2>/dev/null

jq -n --arg branch "$BRANCH" --arg landed "$LANDED_AS" --arg primary "$PRIMARY" \
      --arg removal "$REMOVAL" --arg doc "$DOC" --arg step "$PULL_STEP" '{
  decision: "block",
  reason: (
    "This session'"'"'s worktree is finished with: \($branch) is clean and \($landed). " +
    "Retire it now — a standing instruction from the user'"'"'s config, not something to " +
    "ask about. Read \($doc) before deviating: it explains every refusal below, and what " +
    "prune-worktrees.py does if you leave the tree.\n" +
    $removal + "\n" +
    "  " + $step + ". git -C \($primary) pull --ff-only — but where a pull-based deployer " +
    "derives its work from local..origin (DanielH2018/server does), trigger a deploy tick " +
    "instead; pulling by hand cancels the deploys those commits were due.\n" +
    "Stop at the first step that fails and say which one. If there is still work to do here " +
    "— a deploy to run, a verification to make — say so and keep the worktree; this fires " +
    "once per worktree and will not ask again."
  )
}'
