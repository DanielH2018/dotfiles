#!/bin/bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup|compact
#   timeout: 5
#   order: 10
#   description: Inject abnormal git state at startup, full repo context after a compaction
# SessionStart hook. Text printed to stdout is added as context Claude can see.
# Keep this FAST - it runs every time you open Claude Code.
#
# On startup it prints only what needs action: a dirty tree, a rebase or merge in progress,
# or a failed shim repair, and nothing for a clean repo. A repo's own banner (the server
# repo's session-health) already reports branch and staleness at startup. On compact it
# prints the full block, because no other hook re-primes the model after a compaction.

set -u

# New sessions, and the fresh context a compaction produces. Not resumes, which still
# have their context. Compaction is included because nothing else re-primes after one:
# PreCompact's payload goes to the user, not to the model, so without this branch the
# post-compaction context has no branch, push state or dirty-file list at all.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/lib/hook-input.sh}"
hook_read_input
SOURCE=$(hook_field '.source // "startup"')
case "$SOURCE" in
  startup | compact) ;;
  *) exit 0 ;;
esac

# The transcript-leak SECURITY banner lived here until #693. Only the operator can act on
# it, so it moved to the statusline (statusline-command.sh), out of the model's context.

# DECIDED: the git calls in this hook run without run_bounded, except `git status` below
# (#661). The install-hook-shim run is bounded too (#664), since it is a script, not plumbing. They are local plumbing (rev-parse, log and rev-list over refs, stash list; no
# fetch, no network), and they read refs and a few objects rather than the working tree.
# A bound would add a tempfile and a timeout(1) fork to each for a hang no one has seen.
# `git status --porcelain` is different: it walks the whole working tree, so its cost grows
# with the repo, and it is bounded. The merge-conflict `git diff --diff-filter=U` also reads
# the index against the tree, but it runs only while a merge is in progress.
#
# Only bother if we're in a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Loaded once for the two bounded children below: the shim run and `git status`.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/lib/run-bounded.sh}"
RB_LOADED=0
# shellcheck source=/dev/null
. "$RUN_BOUNDED_PATH" 2>/dev/null && command -v run_bounded >/dev/null 2>&1 && RB_LOADED=1

# Repos that ship an install-hook-shim keep a pre-push guard in .git/, where no
# checkout can restore it. Re-assert it so a stray `git config core.hooksPath`,
# a fresh clone, or a manual delete can't silently drop the guard.
#
# Trusted repos ONLY. This runs at SessionStart -- before you type anything, and before
# the permission gates see any of it -- so keying off "the file exists" would execute
# whatever `bin/install-hook-shim` happens to ship in any repo you cd into, with 2>/dev/null
# swallowing the evidence. Resolved from --git-common-dir rather than --show-toplevel so a
# linked worktree maps back to the repo that owns it instead of failing the check.
# Colon-separated list, overridable with $CLAUDE_SHIM_TRUSTED_ROOTS.
SHIM_REPAIR=""
COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -n "$COMMON_DIR" ] && REPO_ROOT=$(cd "$COMMON_DIR/.." 2>/dev/null && pwd -P); then
  TRUSTED="${CLAUDE_SHIM_TRUSTED_ROOTS:-$HOME/.local/share/chezmoi}"
  trusted=0
  rest="$TRUSTED"
  while [ -n "$rest" ]; do
    entry="${rest%%:*}"
    case "$rest" in *:*) rest="${rest#*:}" ;; *) rest="" ;; esac
    [ -n "$entry" ] || continue
    canon=$(cd "$entry" 2>/dev/null && pwd -P) || continue
    if [ "$canon" = "$REPO_ROOT" ]; then trusted=1; break; fi
  done
  # Bounded (#664). A shim that hangs would otherwise hold this hook until the harness kills
  # it at 5s, and that kill discards the whole repo-context block with nothing saying why.
  # The shim measured 10ms, so 1s is wide headroom, and it leaves room for the 2s status
  # bound below inside the 5s. SESSION_CONTEXT_TIMEOUT_S sets it, for the tests. A shim that
  # did not finish, failed, or cannot run bounded is named instead of relayed.
  if [ "$trusted" -eq 1 ] && [ -x "$REPO_ROOT/bin/install-hook-shim" ]; then
    T_SHIM=${SESSION_CONTEXT_TIMEOUT_S:-1}
    if [ "$RB_LOADED" -ne 1 ]; then
      SHIM_REPAIR="Pre-push shim: not re-asserted (cannot load $RUN_BOUNDED_PATH)"
    else
      # shellcheck disable=SC2016  # $1 belongs to the inner bash
      run_bounded "$T_SHIM" 4096 -- bash -c 'exec "$1" --quiet 2>/dev/null' _ "$REPO_ROOT/bin/install-hook-shim" </dev/null
      # shellcheck disable=SC2153  # RB_STATUS is run_bounded's out-param
      if [ "$RB_STATUS" != ok ]; then
        SHIM_REPAIR="Pre-push shim: not re-asserted (\`bin/install-hook-shim\` did not finish within ${T_SHIM}s ($RB_STATUS))"
      elif [ "$RB_EXIT" -ne 0 ]; then
        SHIM_REPAIR="Pre-push shim: not re-asserted (\`bin/install-hook-shim\` failed (exit $RB_EXIT))"
      else
        SHIM_REPAIR=$RB_OUT
      fi
    fi
  fi
fi

# Uncommitted changes, if any.
#
# Bounded (#581, #661), because status walks the working tree. Measured at 13-15ms warm and
# 152ms cold on the server repo (2,358 tracked files), so 2s leaves wide headroom inside this
# hook's 5s timeout. SESSION_CONTEXT_TIMEOUT_S sets it, for the tests. A status that did not
# finish, failed, or cannot run bounded is named: silence here reads as a clean tree. A
# byte-capped status is fine, since only its first 20 lines are shown.
DIRTY=''
T_STATUS=${SESSION_CONTEXT_TIMEOUT_S:-2}
if [ "$RB_LOADED" -ne 1 ]; then
  UNCHECKED="cannot load $RUN_BOUNDED_PATH"
else
  UNCHECKED=''
  run_bounded "$T_STATUS" 65536 -- bash -c 'exec git status --porcelain 2>/dev/null' </dev/null
  # shellcheck disable=SC2153  # RB_STATUS is run_bounded's out-param
  case "$RB_STATUS" in
    ok | truncated)
      if [ "$RB_EXIT" -eq 0 ]; then
        DIRTY=$(printf '%s\n' "$RB_OUT" | head -20)
      else
        UNCHECKED="\`git status\` failed (exit $RB_EXIT)"
      fi
      ;;
    *) UNCHECKED="\`git status\` did not finish within ${T_STATUS}s ($RB_STATUS)" ;;
  esac
fi
ABNORMAL=''
if [ -n "$UNCHECKED" ]; then
  ABNORMAL+=$'\n'"Uncommitted changes: not checked ($UNCHECKED)"$'\n'
elif [ -n "$DIRTY" ]; then
  ABNORMAL+=$'\n'"Uncommitted changes:"$'\n'"$DIRTY"$'\n'
fi

# In-progress rebase or merge — surface prominently.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  ABNORMAL+=$'\n'"WARNING: Rebase in progress — complete or abort before other work."$'\n'
fi
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | head -5)
  if [ -n "$CONFLICTS" ]; then
    ABNORMAL+=$'\n'"WARNING: Merge in progress with unresolved conflicts:"$'\n'"$CONFLICTS"$'\n'
  else
    ABNORMAL+=$'\n'"WARNING: Merge in progress — commit or abort."$'\n'
  fi
fi

if [ "$SOURCE" = "startup" ]; then
  if [ -n "$SHIM_REPAIR" ] || [ -n "$ABNORMAL" ]; then
    echo "=== Repo context ==="
    [ -n "$SHIM_REPAIR" ] && echo "$SHIM_REPAIR"
    printf '%s' "$ABNORMAL"
  fi
  exit 0
fi

echo "=== Repo context ==="
[ -n "$SHIM_REPAIR" ] && echo "$SHIM_REPAIR"
echo "Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
echo "Last commit: $(git log -1 --pretty=format:'%h %s (%cr)' 2>/dev/null)"

UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)
if [ -n "$UPSTREAM" ]; then
  AHEAD=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null)
  BEHIND=$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null)
  if [ "$AHEAD" -gt 0 ] || [ "$BEHIND" -gt 0 ]; then
    echo "Upstream: $UPSTREAM (ahead $AHEAD, behind $BEHIND)"
  fi
fi
printf '%s' "$ABNORMAL"

STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -gt 0 ]; then
  echo ""
  echo "Stashes: $STASH_COUNT"
fi

echo ""
echo "Recent commits:"
git log -5 --pretty=format:'  %h %s' 2>/dev/null
echo ""

echo ""
echo "This context follows a compaction. The state above is ground truth, re-read just"
echo "now; prefer it over anything the summary asserts about branch, push state or"
echo "working-tree contents. Test pass/fail results, architectural decisions and next"
echo "steps are NOT re-derivable here — carry those across yourself, and preserve user"
echo "corrections and exact error strings verbatim rather than paraphrasing them."

exit 0
