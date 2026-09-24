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

# with_repo_lock <lockfile> <busy-msg> <command> [args...]
#
# Runs the command with the lock held and returns its exit status. Waits if another
# process holds it, saying <busy-msg> once. Where there is no flock (macOS), an atomic
# `mkdir` lock stands in -- see _repo_lock_mkdir below.
with_repo_lock() {
  _lock=$1
  _busy=$2
  shift 2

  if ! command -v flock >/dev/null 2>&1; then
    _repo_lock_mkdir "$_lock" "$_busy" "$@"
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

# The flock fallback: `mkdir` is atomic on every filesystem these tools run on, so exactly
# one process creates the directory and every other one waits. This used to run the command
# UNLOCKED where flock was missing, which is every stock Mac -- two landings could then move
# main under each other, the one thing the lock exists to stop (#581).
#
# A directory lock outlives a holder that is killed, where flock's dies with the fd. So the
# holder records its pid inside, and a waiter that finds the pid dead removes the lock and
# retries. The pid is re-read before the removal, so a waiter never deletes a lock that a
# third process took over in the meantime. A lock directory with no pid file is one whose
# holder died between mkdir and the write; it is treated as stale once it is a minute old,
# and as busy before that, so a holder is never evicted mid-acquisition.
#
# Bounded by REPO_LOCK_WAIT_S (default 3600): past it the tool dies rather than waiting
# forever on a holder that is alive but wedged.
_repo_lock_mkdir() {
  _mlock="$1.d"
  _mbusy=$2
  shift 2
  _waited=0
  _said=0
  while ! mkdir "$_mlock" 2>/dev/null; do
    [ -d "$_mlock" ] || die "cannot create $_mlock"
    _holder=$(cat "$_mlock/pid" 2>/dev/null)
    if [ -n "$_holder" ] && ! kill -0 "$_holder" 2>/dev/null; then
      if [ "$(cat "$_mlock/pid" 2>/dev/null)" = "$_holder" ]; then
        rm -rf "$_mlock" && say "removed a stale lock left by pid $_holder"
      fi
      continue
    fi
    if [ -z "$_holder" ] && [ -n "$(find "$_mlock" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      rm -rf "$_mlock" && say "removed a stale lock with no holder recorded"
      continue
    fi
    [ "$_said" -eq 1 ] || { say "$_mbusy"; _said=1; }
    [ "$_waited" -lt "${REPO_LOCK_WAIT_S:-3600}" ] || die "gave up waiting for $_mlock (held by pid ${_holder:-unknown})"
    sleep 1
    _waited=$((_waited + 1))
  done
  echo $$ >"$_mlock/pid" || { rm -rf "$_mlock"; die "cannot write $_mlock/pid"; }
  ( "$@" )
  _rc=$?
  rm -rf "$_mlock"
  return $_rc
}
