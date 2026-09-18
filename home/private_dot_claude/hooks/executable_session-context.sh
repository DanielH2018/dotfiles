#!/bin/bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup|compact
#   timeout: 5
#   order: 10
# SessionStart hook: inject useful context at the start of each session.
# Text printed to stdout is added as context Claude can see.
# Keep this FAST - it runs every time you open Claude Code.

set -u

# New sessions, and the fresh context a compaction produces. Not resumes, which still
# have their context. Compaction is included because nothing else re-primes after one:
# PreCompact's payload goes to the user, not to the model, so without this branch the
# post-compaction context has no branch, push state or dirty-file list at all.
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
SOURCE=$(hook_field '.source // "startup"')
case "$SOURCE" in
  startup | compact) ;;
  *) exit 0 ;;
esac

# Credentials found in a past transcript, not yet triaged.
#
# Deliberately ABOVE the git check below: a leaked credential is a fact about the machine,
# not about the directory you happened to open Claude in, and gating it on a git repo would
# hide it exactly when you are not working in one. claude-transcript-scan writes this file
# because neither of its unattended callers keeps a verdict — session-end.sh backgrounds it
# with output discarded, and the timer's journal line reaches nobody on a headless host.
#
# The banner stays until it is answered, which is the point. `--accept-baseline` clears it
# by declaring the findings known; `--clear-pending` clears it after a rotation, without
# baselining anything.
PENDING=${CLAUDE_TRANSCRIPT_LEAK_PENDING:-$HOME/.claude/logs/transcript-leaks-pending}
#
# Two record types share the file, both `ts \t count \t detail`. A positive count is a
# finding; a zero count is a run that could not evaluate at all, which needs saying
# separately — silence from a detector that never ran looks exactly like a clean result.
if [ -s "$PENDING" ]; then
  # awk rather than a read loop: bash-3.2 clean, and one process instead of one per line.
  # Every field gets a non-empty placeholder. Tab is an IFS *whitespace* character, so the
  # `read` below collapses consecutive tabs into one delimiter — emitting an empty field
  # shifts every later value one position left, and the down-count lands in a variable that
  # is then compared with -gt. That silently dropped the could-not-evaluate banner entirely.
  awk -F'\t' '
    BEGIN { ftime = "-"; flog = "-"; dtime = "-"; dwhy = "-" }
    $2 + 0 > 0 { found += $2; ftime = $1; flog = $3; next }
    { down += 1; dtime = $1; dwhy = $3 }
    END { printf "%d\t%s\t%s\t%d\t%s\t%s\n", found, ftime, flog, down, dtime, dwhy }
  ' "$PENDING" 2>/dev/null | {
    IFS=$'\t' read -r found ftime flog down dtime dwhy
    if [ "${found:-0}" -gt 0 ] 2>/dev/null; then
      echo "SECURITY: $found untriaged credential finding(s) in Claude transcripts, last seen $ftime."
      echo "  Details (redacted — fingerprints, not values): $flog"
      echo "  Rotate what is named, then: claude-transcript-scan --clear-pending"
      echo "  Or, if these are known not to be credentials: claude-transcript-scan --accept-baseline"
      echo ""
    fi
    if [ "${down:-0}" -gt 0 ] 2>/dev/null; then
      echo "SECURITY: the transcript credential scan could not run $down time(s), last at $dtime ($dwhy)."
      echo "  Nothing was checked in those windows. Install what is missing, then: claude-transcript-scan --clear-pending"
      echo ""
    fi
  }
fi

# Only bother if we're in a git repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

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
  if [ "$trusted" -eq 1 ] && [ -x "$REPO_ROOT/bin/install-hook-shim" ]; then
    SHIM_REPAIR=$("$REPO_ROOT/bin/install-hook-shim" --quiet 2>/dev/null)
  fi
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

echo "=== Repo context ==="
[ -n "$SHIM_REPAIR" ] && echo "$SHIM_REPAIR"
echo "Branch: $BRANCH"
echo "Last commit: $(git log -1 --pretty=format:'%h %s (%cr)' 2>/dev/null)"

# Ahead/behind upstream, if tracking branch exists.
UPSTREAM=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null)
if [ -n "$UPSTREAM" ]; then
  AHEAD=$(git rev-list --count '@{upstream}..HEAD' 2>/dev/null)
  BEHIND=$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null)
  if [ "$AHEAD" -gt 0 ] || [ "$BEHIND" -gt 0 ]; then
    echo "Upstream: $UPSTREAM (ahead $AHEAD, behind $BEHIND)"
  fi
fi

# Uncommitted changes, if any.
DIRTY=$(git status --porcelain 2>/dev/null | head -20)
if [ -n "$DIRTY" ]; then
  echo ""
  echo "Uncommitted changes:"
  echo "$DIRTY"
fi

# In-progress rebase or merge — surface prominently.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
if [ -d "$GIT_DIR/rebase-merge" ] || [ -d "$GIT_DIR/rebase-apply" ]; then
  echo ""
  echo "WARNING: Rebase in progress — complete or abort before other work."
fi
if [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  CONFLICTS=$(git diff --name-only --diff-filter=U 2>/dev/null | head -5)
  echo ""
  if [ -n "$CONFLICTS" ]; then
    echo "WARNING: Merge in progress with unresolved conflicts:"
    echo "$CONFLICTS"
  else
    echo "WARNING: Merge in progress — commit or abort."
  fi
fi

# Stash count, if any.
STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -gt 0 ]; then
  echo ""
  echo "Stashes: $STASH_COUNT"
fi

# Recent commits for context on what the user has been working on.
echo ""
echo "Recent commits:"
git log -5 --pretty=format:'  %h %s' 2>/dev/null
echo ""

if [ "$SOURCE" = "compact" ]; then
  echo ""
  echo "This context follows a compaction. The state above is ground truth, re-read just"
  echo "now; prefer it over anything the summary asserts about branch, push state or"
  echo "working-tree contents. Test pass/fail results, architectural decisions and next"
  echo "steps are NOT re-derivable here — carry those across yourself, and preserve user"
  echo "corrections and exact error strings verbatim rather than paraphrasing them."
fi

exit 0
