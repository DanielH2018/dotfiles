"""A child process run under a wall-clock and an output-byte bound: run_bounded, in Python.

The hooks' rule (#581, hooks/lib/run-bounded.sh) holds inside this package too: no child a
hook starts may run or buffer without a ceiling, and hitting one is could-not-evaluate,
never a pass. The status names are run_bounded's, so a message reads the same whichever
side produced it:

  ok         ran to completion; `exit` is its own exit code
  timeout    hit the wall-clock bound and was killed
  truncated  wrote more than the byte bound; `out` holds the first `cap` bytes
  killed     died of a signal this did not send
  error      could not be started
"""

import contextlib
import os
import signal
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Result:
    status: str
    exit: int
    out: str


def run(
    argv: Sequence[str], timeout: float, cap: int, env: Mapping[str, str], cwd: str | None = None
) -> Result:
    """Runs argv with stdin closed and stderr discarded, and returns its bounded stdout.

    The child leads its own process group, and a timeout kills the group, so a grandchild
    holding the pipe open cannot keep this waiting. Trailing newlines are stripped from
    `out`, as a shell `$(...)` would.
    """
    try:
        proc = subprocess.Popen(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(env),
            cwd=cwd,
            start_new_session=True,
        )
    except OSError:
        return Result("error", -1, "")
    try:
        raw, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return Result("timeout", -1, "")
    out = raw[:cap].decode("utf-8", "replace").rstrip("\n")
    if len(raw) > cap:
        return Result("truncated", proc.returncode, out)
    if proc.returncode < 0:
        return Result("killed", proc.returncode, out)
    return Result("ok", proc.returncode, out)
