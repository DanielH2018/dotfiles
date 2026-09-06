#!/usr/bin/env bash
# allow-clean-reset.sh
#
# PermissionRequest hook for Bash. Auto-approves `git reset --hard origin/master` (or
# `origin/main`) when the working tree is provably clean and the repo is not mid-rebase,
# mid-merge, or mid-cherry-pick — the only things a hard reset can discard in that state.
# Anything else produces no decision and falls through to the `Bash(git reset --hard:*)`
# ask rule.
#
# `git reset --hard` sits in the ask list because it takes an arbitrary ref and discards
# both uncommitted edits and local commits with no undo the way `rm` has none. But the
# homelab landing procedure (this repo's own CLAUDE.md, "After a PR Merges") runs this
# exact command against a CLEAN worktree to fast-forward local state onto origin before a
# follow-up commit, and it recurs by design: 16 prompts in 7 days on daniel-box, every one
# `git reset --hard origin/master`, most piped through `2>&1 | tail -N` or carrying
# `-q`/`--quiet`. On a clean tree the only thing discarded is local commits, and those
# stay in the reflog — nothing here is actually at risk of loss.
#
# Deliberately narrow, same posture as allow-safe-rm.sh's option table: the ref must be
# the literal `origin/master` or `origin/main`, never a SHA, an `@{...}` reflog
# expression, or a pathspec after `--`. A SHA or reflog ref can point somewhere the
# operator did not expect; widening the ref set is a decision for a human editing this
# file, not something this hook should infer from a shape it hasn't seen yet.
#
# The clean-tree check is `git status --porcelain --untracked-files=no`: untracked files
# are not touched by `reset --hard` (it only rewrites tracked, indexed content), so they
# must not block the approval — a worktree with scratch files sitting in it would
# otherwise never qualify. A rebase/merge/cherry-pick in progress is refused even on a
# clean tree, because `reset --hard` there abandons the operation's state, which is a
# real loss `git status --porcelain` does not show.
#
# What this hook can NOT see: a `pre-commit`/`post-checkout` hook or another process
# racing a write into the tree between the status check and the reset actually running.
# That race exists for the ask-listed path too; this hook does not make it worse.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
# shellcheck source=/dev/null
. "${CMDPARSE_LIB:-${BASH_SOURCE[0]%/*}/executable_cmdparse.sh}"

hook_read_input
COMMAND=$(hook_field '.tool_input.command // ""')
[[ -z $COMMAND ]] && exit 0
CWD=$(hook_field '.cwd // ""')
[[ -z $CWD ]] && CWD=$PWD

allow() {
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
  exit 0
}

trim() {
  local s=$1
  s=${s#"${s%%[![:space:]]*}"}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

cmd_parse "$COMMAND" || exit 0
[[ $CP_STATUS == ok ]] || exit 0
# One command, or one piped through a trailing `tail` — nothing else. A chain
# (`&&`, `;`, `&`) is always a refusal: whatever follows the reset is somebody else's
# judgement to make, not something folded into this one.
(( CP_NSEG == 1 || CP_NSEG == 2 )) || exit 0
[[ -z ${CP_HEREDOC[0]:-} ]] || exit 0

# Strip a trailing `2>&1` before matching — it redirects where stderr goes, not what
# the command does, and the real invocations almost always carry it ahead of the pipe.
seg0=$(trim "${CP_SEG[0]}")
seg0=$(printf '%s' "$seg0" | sed -E 's/[[:space:]]+2>&1[[:space:]]*$//')
seg0=$(trim "$seg0")

# Exactly `git reset --hard [-q|--quiet] <ref> [-q|--quiet]` — the quiet flag may sit
# on either side of the ref (both real orderings seen in practice), but only once.
if [[ ! $seg0 =~ ^git[[:space:]]+reset[[:space:]]+--hard([[:space:]]+(-q|--quiet))?[[:space:]]+(origin/master|origin/main)([[:space:]]+(-q|--quiet))?$ ]]; then
  exit 0
fi

if (( CP_NSEG == 2 )); then
  # Only a literal pipe into `tail` is tolerated, mirroring how allow-compound-bash.sh
  # reads the same shape elsewhere: the separator must be a single `|`, not `||`, and
  # the second segment must be nothing but `tail -n N` / `tail -N`.
  [[ ${CP_SEP[0]} == '|' ]] || exit 0
  [[ -z ${CP_HEREDOC[1]:-} ]] || exit 0
  seg1=$(trim "${CP_SEG[1]}")
  [[ $seg1 =~ ^tail[[:space:]]+(-n[[:space:]]*[0-9]+|-[0-9]+)$ ]] || exit 0
fi

# No substitution anywhere in the command — a `$(...)` or backtick could smuggle a
# different ref or a second command in through the ref position or the redirect, and
# cmd_parse pulls those out as CP_SUBSEG regardless of where they sit textually.
(( CP_NSUBSEG == 0 )) || exit 0

GITDIR=$(git -C "$CWD" rev-parse --git-dir 2>/dev/null) || exit 0
[[ -z $GITDIR ]] && exit 0
[[ $GITDIR == /* ]] || GITDIR="$CWD/$GITDIR"

for marker in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD; do
  [[ -e "$GITDIR/$marker" ]] && exit 0
done

STATUS=$(git -C "$CWD" status --porcelain --untracked-files=no 2>/dev/null) || exit 0
[[ -z $STATUS ]] || exit 0

allow
