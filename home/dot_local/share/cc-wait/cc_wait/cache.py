"""One read per interval per host for a remote source, shared by every wait on the same source.

Ten sessions waiting on one pull request would otherwise make ten API calls a poll. A remote
read goes through `cached_read`: the first waiter past the cache's age reads and writes the
result, and every other waiter in that window reads the file. An flock serialises the refresh,
so two waiters cannot both decide the cache is stale and both call the API.

A failed read is never cached: the next waiter tries for itself, and the loop's own retry
count is what gives up.
"""

import hashlib
import json
import os
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path

from cc_wait.source import Reading

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl


def cache_dir(env: Mapping[str, str]) -> Path:
    base = env.get("XDG_CACHE_HOME") or str(Path(env.get("HOME", "~")).expanduser() / ".cache")
    return Path(base) / "cc-wait"


def _load(path: Path) -> Reading | None:
    try:
        data = json.loads(path.read_text())
        return Reading(str(data["state"]), str(data.get("detail", "")))
    except OSError, ValueError, KeyError, TypeError:
        return None


def _lock_exclusive(lock) -> None:
    """Block until this process holds the lock file exclusively (closing it releases)."""
    if sys.platform == "win32":
        # msvcrt locks a byte range, and the file is empty: seek then lock byte 0, which
        # Windows allows past EOF. LK_LOCK retries for ~10s then raises, so loop.
        while True:
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                continue
    fcntl.flock(lock, fcntl.LOCK_EX)


def cached_read(
    key: str,
    max_age_s: float,
    read: Callable[[], Reading],
    directory: Path,
    clock: Callable[[], float] = time.time,
) -> Reading:
    """`read()`'s result, or a result another waiter on `key` got less than `max_age_s` ago."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{hashlib.sha256(key.encode()).hexdigest()[:32]}.json"

    def fresh() -> Reading | None:
        try:
            age = clock() - path.stat().st_mtime
        except OSError:
            return None
        return _load(path) if age < max_age_s else None

    hit = fresh()
    if hit:
        return hit
    with open(path.with_suffix(".lock"), "w") as lock:
        _lock_exclusive(lock)
        hit = fresh()
        if hit:
            return hit
        reading = read()
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps({"state": reading.state, "detail": reading.detail}))
        tmp.replace(path)
        return reading
