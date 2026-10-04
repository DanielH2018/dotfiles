"""The one wait loop: read a source until a terminal state, a budget, or a source that fails.

Re-running a wait is resuming it. The loop keeps no state between runs, because the state
lives in what it waits on, so the command printed on a timeout is the reattach.

Output, one line each, flushed so a Monitor sees it at once:

    16:20:01 <state>: <detail>          every change of state or detail
    WAIT: <state> <detail>              the terminal state; exits with that state's code
    WAIT: timeout ... re-run: <command> the budget elapsed; exits 75
    WAIT: error <why>                   cc-wait could not wait; exits 2
"""

import sys
import time
from collections.abc import Callable
from typing import TextIO

from cc_wait.source import (
    BUDGET_ELAPSED,
    COULD_NOT_WAIT,
    Bound,
    ReadError,
    Reading,
    SourceError,
    validate,
)
from cc_wait.watch import wait_for_change

# Consecutive failed reads before the wait gives up. A transient error (a network blip, a file
# mid-rename) clears within one or two reads; five in a row is a probe that is broken.
MAX_READ_FAILURES = 5


def _say(out: TextIO, line: str) -> None:
    print(line, file=out, flush=True)


def run(
    bound: Bound,
    budget_s: float,
    resume: str,
    out: TextIO = sys.stdout,
    clock: Callable[[], float] = time.monotonic,
    wait_change: Callable[[tuple[str, ...], float], None] = wait_for_change,
    stamp: Callable[[], str] = lambda: time.strftime("%H:%M:%S"),
) -> int:
    """Wait on `bound` and return the exit code the process should end with.

    Args:
      bound: the source, already bound to its arguments.
      budget_s: how long to wait before giving up with exit 75.
      resume: the command that resumes this wait, printed when the budget elapses.
      out: where the event lines go.
      clock, wait_change, stamp: injected so the tests need no real time or real files.
    """
    try:
        desc = validate(bound.describe())
    except SourceError as exc:
        _say(out, f"WAIT: error cc-wait refuses this source: {exc}")
        return COULD_NOT_WAIT
    deadline = clock() + budget_s
    last: Reading | None = None
    failures = 0
    while True:
        try:
            reading = bound.read()
        except ReadError as exc:
            failures += 1
            if failures >= MAX_READ_FAILURES:
                _say(out, f"WAIT: error {failures} reads in a row failed; the last: {exc}")
                return COULD_NOT_WAIT
        else:
            failures = 0
            code = desc.terminal.get(reading.state)
            if code is not None:
                _say(out, f"WAIT: {reading.state} {reading.detail}".rstrip())
                return code
            if reading != last:
                detail = f": {reading.detail}" if reading.detail else ""
                _say(out, f"{stamp()} {reading.state}{detail}")
                last = reading
        remaining = deadline - clock()
        if remaining <= 0:
            state = last.state if last else "unread"
            _say(out, f"WAIT: timeout still {state} after {budget_s:g}s; re-run: {resume}")
            return BUDGET_ELAPSED
        wait_change(desc.watch, min(desc.interval_s, remaining))
