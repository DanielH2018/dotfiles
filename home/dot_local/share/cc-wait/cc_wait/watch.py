"""Block until a watched path changes or a timeout passes, whichever comes first.

`inotifywait` (Linux) or `fswatch` (macOS) wakes the loop as soon as a probe's file changes.
Neither is required: without one, or when one fails to start, this sleeps out the timeout and
the loop's interval does the work. A missed event costs at most one interval, because the loop
re-reads the source after every return from here.
"""

import math
import shutil
import subprocess
import time
from collections.abc import Callable, Iterable
from pathlib import Path

INOTIFY_EVENTS = "modify,attrib,close_write,moved_to,create,delete"


def watch_targets(paths: Iterable[str]) -> list[str]:
    """The existing directories to watch for `paths`.

    A file is watched through its parent directory, which reports the file being created,
    replaced by a rename or written. A path whose parent does not exist yet is skipped; the
    interval still covers it.
    """
    targets: list[str] = []
    for raw in paths:
        path = Path(raw)
        target = path if path.is_dir() else path.parent
        if target.is_dir() and str(target) not in targets:
            targets.append(str(target))
    return targets


def wait_for_change(
    paths: Iterable[str],
    timeout_s: float,
    which: Callable[[str], str | None] = shutil.which,
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Return when one of `paths` changes, or after `timeout_s` seconds."""
    if timeout_s <= 0:
        return
    targets = watch_targets(paths)
    started = clock()
    if targets and which("inotifywait"):
        # -t 0 means "forever" to inotifywait, so the timeout never rounds down to it.
        cmd = ["inotifywait", "-qq", "-t", str(max(1, math.ceil(timeout_s))), "-e", INOTIFY_EVENTS]
        if _ran(run, [*cmd, *targets], timeout_s):
            return
    elif targets and which("fswatch"):
        # fswatch has no timeout of its own; -1 exits after the first batch of events.
        if _ran(run, ["fswatch", "-1", *targets], timeout_s):
            return
    sleep(max(0.0, timeout_s - (clock() - started)))


def _ran(run, cmd: list[str], timeout_s: float) -> bool:
    """Whether the watcher returned on an event or its own timeout, not on an error."""
    try:
        result = run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout_s + 5,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return True
    except OSError:
        return False
    # inotifywait exits 0 on an event and 2 on its timeout; 1 is an error such as a watched
    # directory vanishing, which must fall back to sleeping rather than spin the loop.
    return result.returncode in (0, 2)
