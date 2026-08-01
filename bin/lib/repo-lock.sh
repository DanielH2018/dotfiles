# shellcheck shell=bash
#
# One repo-wide advisory lock, for the tools that must not run twice at once across
# the worktrees of this repo — land (one lander at a time) and try (one bench at a
# time). Each keeps its OWN lock file: sharing one would make a bench wait on a full
# landing, and would change what land's "one lander at a time" means. What they share
# is the acquisition, which is what had drifted.
#
# Expects the caller to have defined say() and die() already — both do, with their own
# prefix, and the messages here read as the tool's own.
#
# Kept bash-3.2 clean, like the two callers.

# with_repo_lock <lockfile> <busy-msg> <no-flock-msg> <command> [args...]
#
# Runs the command with the lock held and returns its exit status. Waits if another
# process holds it. Where there is no flock (macOS), runs the command anyway and says
# so — the serialisation is worth having where it exists and not worth refusing over
# where it does not.
with_repo_lock() {
  _lock=$1
  _busy=$2
  _noflock=$3
  shift 3

  if ! command -v flock >/dev/null 2>&1; then
    say "flock unavailable — $_noflock"
    "$@"
    return $?
  fi

  exec 9>"$_lock" || die "cannot open $_lock"
  if ! flock -n 9; then
    say "$_busy"
    flock 9 || die "could not take $_lock"
  fi

  # Run the body with fd 9 closed in the child, while this shell keeps it open and
  # locked. A bash redirect sets no close-on-exec, so without this every process
  # forked below inherits the lock fd — including `git credential-cache--daemon`,
  # which `git push` starts and which by design never exits. It then holds the flock
  # forever, and every later run blocks on a lock with no holder: measured 2026-07-30,
  # a daemon from one landing blocked the next one 45 minutes later and the lock path
  # had to be unlinked by hand.
  #
  # Closing the child's copy releases nothing — the lock lives on the open file
  # description this shell still holds — so the mutex is unchanged. Closing it *here*
  # instead would drop the lock and quietly delete the mutual exclusion, which is why
  # the tests pin both halves together.
  #
  # This guard is the reason the acquisition is shared at all. It was written for
  # land, after the incident above, and try never got it: the same six lines of setup
  # were copied but the fix was not. A lock whose correctness depends on each caller
  # remembering one redirect is a lock that will lose it again.
  ( "$@" ) 9>&-
  _rc=$?
  exec 9>&-
  return $_rc
}
