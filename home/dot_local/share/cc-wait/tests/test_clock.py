"""The `time` source under a fake wall clock, plus one real run through the CLI."""

import io
from datetime import UTC, datetime

import pytest

from cc_wait import cli
from cc_wait.clock import TimeSource
from cc_wait.source import SourceError

NOW = datetime(2026, 10, 29, 12, 22, tzinfo=UTC).timestamp()


def bind(*args, now=NOW):
    clock = [now]
    bound = TimeSource(now=lambda: clock[0]).bind(list(args))
    return bound, clock


def test_after_ends_once_the_duration_has_elapsed():
    bound, clock = bind("--after", "18m")
    assert bound.read().state == "waiting"
    clock[0] = NOW + 18 * 60
    assert bound.read().state == "reached"


def test_at_names_today_in_its_zone():
    bound, _ = bind("--at", "13:40+01:00")
    assert bound.deadline == NOW + 18 * 60
    assert bound.read().detail == "2026-10-29T12:40:00Z"


def test_resuming_after_waits_for_the_same_moment_not_a_fresh_duration():
    bound, _ = bind("--after", "900")
    assert bound.resume_args() == ["--at", "2026-10-29T12:37:00Z"]


@pytest.mark.parametrize(
    ("args", "why"),
    [
        (["--at", "12:00Z"], "already passed"),
        (["--at", "12:40"], "has no zone"),
        (["--at", "soon"], "ISO 8601"),
        (["--after", "15 minutes"], "needs a duration"),
    ],
)
def test_a_time_it_cannot_wait_for_is_refused(args, why):
    with pytest.raises(SourceError, match=why):
        bind(*args)


def test_a_time_wait_ends_with_0_at_its_deadline(tmp_path):
    out = io.StringIO()
    assert (
        cli.main(["time", "--after", "0.3", "--budget", "20"], out=out, cwd=tmp_path, env={}) == 0
    )
    assert out.getvalue().splitlines()[-1].startswith("WAIT: reached ")


def test_an_elapsed_budget_prints_an_absolute_resume_command(tmp_path):
    out = io.StringIO()
    argv = ["--budget", "0.2", "time", "--after", "1h"]
    assert cli.main(argv, out=out, cwd=tmp_path, env={}) == 75
    resume = out.getvalue().splitlines()[-1].partition("re-run: ")[2]
    assert resume.startswith("cc-wait time --at 20")
    assert resume.endswith("Z --budget 0.2")
