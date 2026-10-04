"""The loop under a fake clock: no real time passes and no file is watched."""

import io

from cc_wait import loop
from cc_wait.source import Description, ReadError, Reading


class Script:
    """A bound source that returns scripted readings, one per read."""

    def __init__(self, readings, terminal=None):
        self.readings = list(readings)
        self.terminal = terminal or {"done": 0, "failed": 1}
        self.reads = 0

    def describe(self):
        return Description(terminal=self.terminal, interval_s=10)

    def read(self):
        self.reads += 1
        item = self.readings.pop(0) if len(self.readings) > 1 else self.readings[0]
        if isinstance(item, Exception):
            raise item
        return item


def drive(bound, budget_s=100):
    """Run the loop with a clock that advances by each wait's timeout."""
    now = [0.0]
    out = io.StringIO()
    code = loop.run(
        bound,
        budget_s,
        "cc-wait thing 1",
        out=out,
        clock=lambda: now[0],
        wait_change=lambda _paths, timeout: now.__setitem__(0, now[0] + timeout),
        stamp=lambda: "T",
    )
    return code, out.getvalue().splitlines()


def test_a_terminal_state_ends_the_wait_with_its_own_code():
    bound = Script([Reading("running", "a"), Reading("running", "a"), Reading("failed", "boom")])
    code, lines = drive(bound)
    assert code == 1
    assert lines == ["T running: a", "WAIT: failed boom"]


def test_the_budget_elapsing_exits_75_with_the_resume_command():
    code, lines = drive(Script([Reading("running")]), budget_s=25)
    assert code == 75
    assert lines[-1] == "WAIT: timeout still running after 25s; re-run: cc-wait thing 1"


def test_a_read_that_keeps_failing_gives_up_with_2():
    bound = Script([ReadError("no route")])
    code, lines = drive(bound, budget_s=1000)
    assert code == 2
    assert bound.reads == loop.MAX_READ_FAILURES
    assert "no route" in lines[-1]


def test_one_failed_read_is_retried_rather_than_ending_the_wait():
    code, _ = drive(Script([ReadError("blip"), Reading("done", "ok")]))
    assert code == 0


def test_a_misdeclared_source_is_refused_before_any_read():
    bound = Script([Reading("done")], terminal={"done": 0})
    code, lines = drive(bound)
    assert code == 2
    assert bound.reads == 0
    assert "no failure state" in lines[0]
