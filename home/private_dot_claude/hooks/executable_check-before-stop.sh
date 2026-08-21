#!/bin/bash
# Stop hook: verify the session didn't leave the repo in a bad state.
# If there are staged changes on a protected branch, block stopping
# and tell Claude to move them to a feature branch.

set -u

# shellcheck disable=SC1091  # optional per-host env, not present in the chezmoi tree
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

# Avoid loops - if we already forced Claude to continue once, let it stop now.
ACTIVE=$(hook_field '.stop_hook_active // false')
[ "$ACTIVE" = "true" ] && exit 0

# Only care about git repos.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Skip repos that commit directly to main by convention.
# The configured vault (if any) is matched by toplevel path; the dotfiles repo
# is matched by remote URL below to also cover worktrees at different paths.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "${CLAUDE_VAULT_DIR:-}" ] && [ "$TOPLEVEL" = "$CLAUDE_VAULT_DIR" ]; then
  exit 0
fi

# Skip worktrees of repos that commit directly to main by convention
# (remote URL match — covers worktrees at arbitrary paths).
#
# DanielH2018/server used to be exempted here too, on the grounds that its commits go
# straight to master. They do not: settings.json's autoMode hard_deny calls master a
# production deploy trigger reachable only through a PR, and that repo's CLAUDE.md
# specifies one worktree and one PR per session. The exemption therefore switched the
# guard off in the one repo whose default branch deploys to live infrastructure — and it
# sat above the rebase and merge-conflict blocks below, which apply on every branch, so a
# session there could also walk away mid-rebase with nothing said. Removed 2026-08-21.
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
case "$REMOTE_URL" in
  *dotfiles*) exit 0 ;;
esac

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)

# Check for in-progress rebase — leaving mid-rebase breaks the repo
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  jq -n '{
    decision: "block",
    reason: "A rebase is in progress. Complete it with `git rebase --continue` or abort with `git rebase --abort` before stopping."
  }'
  exit 0
fi

# Check for in-progress merge
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | head -5)
  if [ -n "$CONFLICTS" ]; then
    jq -n --arg files "$CONFLICTS" '{
      decision: "block",
      reason: ("Merge in progress with unresolved conflicts:\n\($files)\n\nResolve conflicts and commit, or abort with `git merge --abort`.")
    }'
  else
    jq -n '{
      decision: "block",
      reason: "A merge is in progress. Commit the merge result or abort with `git merge --abort` before stopping."
    }'
  fi
  exit 0
fi

# Check for unstaged modifications (more common than staged-only)
UNSTAGED=$(git diff --name-only 2>/dev/null | head -5)
STAGED=$(git diff --cached --name-only 2>/dev/null | head -5)

# And for a file that was never added at all. `git diff` and `git diff --cached` are both
# blind to one, so a new file a session wrote and forgot is the one kind of lost work this
# hook could not see — the kind with no history to recover it from.
#
# It is also, measurably, the common case rather than an edge one. Of 54 dirty_exit events
# logged to sessions.log, 52 were on master, and 12 of those in a single afternoon were one
# untracked file: a finished 248-line evaluation that a session wrote, never committed, and
# left for every later session to trip over. `--exclude-standard` means .gitignore already
# answers for build output and scratch, so what reaches here is a file nobody has classified.
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | head -5)

case "$BRANCH" in
  main|master|production|release)
    if [ -n "$STAGED" ]; then
      jq -n --arg branch "$BRANCH" '{
        decision: "block",
        reason: ("There are staged changes on protected branch \($branch). Please create a feature branch with `git switch -c <name>` and move the changes there before finishing.")
      }'
      exit 0
    fi
    if [ -n "$UNSTAGED" ]; then
      jq -n --arg branch "$BRANCH" --arg files "$UNSTAGED" '{
        decision: "block",
        reason: ("There are unstaged modifications on protected branch \($branch):\n\($files)\n\nPlease either stage and commit these on a feature branch, or confirm with the user that discarding them is intentional.")
      }'
      exit 0
    fi
    # Last, because it is the least likely of the three to be work in progress and the
    # most likely to be deliberate. Naming the three exits matters more here than in the
    # blocks above: an untracked file has no history, so "leave it" is a real answer and
    # the session needs to be able to give it rather than guess at committing it.
    if [ -n "$UNTRACKED" ]; then
      jq -n --arg branch "$BRANCH" --arg files "$UNTRACKED" '{
        decision: "block",
        reason: ("There are untracked files on protected branch \($branch):\n\($files)\n\nAn untracked file exists nowhere but this disk. Decide which it is: commit it on a feature branch, add it to .gitignore if it is build output or scratch, delete it, or tell the user it is deliberate and leave it. Do not guess — say which you chose and why.")
      }'
      exit 0
    fi
    ;;
esac

exit 0
