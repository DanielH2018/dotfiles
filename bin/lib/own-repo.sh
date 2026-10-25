# shellcheck shell=bash
#
# Stops a repo tool from acting on a repository other than its own: it dies unless the
# shell's working directory is in the same repository as the checkout holding the script.
#
# land and land-sync act on whatever repository git finds from the cwd, and nothing tied
# that to the checkout the script came from. Run by its absolute path from a server
# worktree, land printed `landing worktree-agent-dotfiles-on-daniel-server (PR #6118)`
# and fetched the server remote. It stopped only because that repo has no origin/main.
# A foreign repo whose default branch is main would have been rebased and fast-forwarded
# onto a branch nobody asked to land (#1005).
#
# "Same repository" means the same git common dir, not the same toplevel. Every worktree
# of a repo shares the common dir, so the primary checkout's bin/land may still land a
# branch from a linked worktree, which is the case the lock is built around.
#
# The guard refuses rather than retargeting to the script's own checkout. A cwd in
# another repo means the caller is confused about where they are, and guessing which
# branch they meant is the bug itself.
#
# Kept bash-3.2 clean, like the callers.

#######################################
# Die unless the cwd and the script share a git common dir.
# Globals:
#   None read; sets _self_dir, _self_common and _cwd_common.
# Arguments:
#   The calling script's path, normally "${BASH_SOURCE[0]}".
# Outputs:
#   Nothing on success. On a mismatch, die() prints the refusal to STDERR.
# Returns:
#   0 when both are in the same repository. Otherwise die() exits the caller with 1,
#   so the caller must have defined die() already.
#######################################
require_own_repo() {
  _self_dir=$(cd "$(dirname "$1")" && pwd -P) || die "cannot resolve the directory of $1"
  # Checked apart from the cd: `cd ""` succeeds in bash, so an empty answer would
  # resolve to the script's own directory and read as some other repository.
  _self_common=$(cd "$_self_dir" && git rev-parse --git-common-dir 2>/dev/null) &&
    [ -n "$_self_common" ] &&
    _self_common=$(cd "$_self_dir" && cd "$_self_common" && pwd -P) ||
    die "$_self_dir is not inside a git checkout — run the copy in this repo's own bin/"
  _cwd_common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P) || die "cannot resolve this repo's git dir"
  [ "$_self_common" = "$_cwd_common" ] ||
    die "the working directory is in $(git rev-parse --show-toplevel), a different repository from this script's ($(dirname "$_self_dir")) — cd into a checkout of that repository, or run the copy in this repo's own bin/"
}
