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
# A live pid is not proof on its own: the OS can hand a dead holder's pid to an unrelated
# process, and the lock would then read as held until REPO_LOCK_WAIT_S ran out (#610). So
# the holder also records its start time, in a file of its own, and a waiter that finds the
# pid alive but started at a different time treats the lock as stale. The start time is a
# separate file rather than a second field in `pid` because a caller running an older copy
# of this library reads `pid` whole: "123 <time>" would fail its `kill -0` and it would
# evict a live holder. The start file is written before the pid file, so any waiter that
# can read the pid can read the start time too. Where either time is unknown -- a holder
# from before this change, or a `ps` that fails -- the pid alone decides, as it did before.
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
    _hstart=$(cat "$_mlock/start" 2>/dev/null)
    _stale=''
    if [ -n "$_holder" ]; then
      if ! kill -0 "$_holder" 2>/dev/null; then
        _stale="left by pid $_holder"
      elif [ -n "$_hstart" ]; then
        _now=$(_repo_lock_started "$_holder")
        if [ -n "$_now" ] && [ "$_now" != "$_hstart" ]; then
          _stale="left by pid $_holder, which another process has since reused"
        fi
      fi
    fi
    if [ -n "$_stale" ]; then
      if [ "$(cat "$_mlock/pid" 2>/dev/null)" = "$_holder" ] &&
        [ "$(cat "$_mlock/start" 2>/dev/null)" = "$_hstart" ]; then
        rm -rf "$_mlock" && say "removed a stale lock $_stale"
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
  _repo_lock_started $$ >"$_mlock/start" 2>/dev/null
  echo $$ >"$_mlock/pid" || { rm -rf "$_mlock"; die "cannot write $_mlock/pid"; }
  ( "$@" )
  _rc=$?
  rm -rf "$_mlock"
  return $_rc
}

# _repo_lock_started <pid>: when that process started, as one line, or nothing if unknown.
# `ps -o lstart=` rather than Linux's /proc/<pid>/stat field 22 because it answers on both
# procps and BSD ps, so the Linux test suite exercises the macOS path, which is the one
# that matters: this fallback only runs where flock is missing. LC_ALL=C keeps the day and
# month names fixed, and the whitespace is squeezed so column padding cannot differ between
# the holder's write and a waiter's read.
_repo_lock_started() {
  LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'
}
