"""The `time` source: a wall-clock deadline passes.

The clock is this wait's writer, and a clock cannot crash, so `time` is the one source with
no failure state. It sets `Description.clock`, which exempts it from `validate()`'s
failure-state rule; a repo probe's `--describe` cannot set that field.

`--after` resolves to an absolute deadline when the source binds, and `resume_args()` names
that deadline as `--at`. Re-running the printed resume command after a budget elapses then
waits for the same moment, rather than restarting the duration.
"""

import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from datetime import time as clock_time

from cc_wait.source import ArgParser, Description, ParsedSource, Reading

_DURATION = re.compile(r"^(\d+(?:\.\d+)?)([smh]?)$")
_UNIT_S = {"": 1, "s": 1, "m": 60, "h": 3600}


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class TimeWait:
    deadline: float
    now: Callable[[], float] = field(default=time.time, repr=False, compare=False)

    def describe(self) -> Description:
        # A 1s interval: the wait has no file to watch, so it ends at most 1s late.
        return Description(terminal={"reached": 0}, interval_s=1.0, clock=True)

    def read(self) -> Reading:
        # The detail stays fixed while waiting, so the loop prints one line, not one a second.
        state = "reached" if self.now() >= self.deadline else "waiting"
        return Reading(state, _iso(self.deadline))

    def resume_args(self) -> list[str]:
        return ["--at", _iso(self.deadline)]


class TimeSource(ParsedSource):
    name = "time"
    summary = "a wall-clock time passes (--at 12:40Z) or a duration elapses (--after 15m)"

    def __init__(self, now: Callable[[], float] = time.time):
        self.now = now

    def parser(self) -> ArgParser:
        parser = ArgParser(prog="cc-wait time", add_help=False)
        when = parser.add_mutually_exclusive_group(required=True)
        when.add_argument(
            "--at",
            help="an ISO 8601 time with a zone: 12:40Z, 12:40+01:00 (today in that zone), or "
            "2026-10-29T12:40Z",
        )
        when.add_argument("--after", help="a duration: 900, 900s, 15m or 2h")
        return parser

    def bind(self, args: list[str]) -> TimeWait:
        parser = self.parser()
        ns = parser.parse_args(args)
        now = self.now()
        if ns.after is not None:
            match = _DURATION.match(ns.after)
            if not match:
                parser.error(f"--after needs a duration such as 900, 15m or 2h, not {ns.after!r}")
            return TimeWait(now + float(match.group(1)) * _UNIT_S[match.group(2)], self.now)
        deadline = self._parse_at(parser, ns.at, now)
        if deadline <= now:
            # A passed time is refused, never rolled to tomorrow: the caller meant a moment
            # that has gone, and a wait that ends a day late reads as one that worked.
            parser.error(f"--at {ns.at} has already passed ({_iso(now)} now)")
        return TimeWait(deadline, self.now)

    @staticmethod
    def _parse_at(parser: ArgParser, raw: str, now: float) -> float:
        try:
            if "T" in raw or " " in raw:
                moment = datetime.fromisoformat(raw)
            else:
                moment = clock_time.fromisoformat(raw)
        except ValueError:
            parser.error(f"--at needs an ISO 8601 time such as 12:40Z, not {raw!r}")
        if moment.tzinfo is None:
            parser.error(f"--at {raw} has no zone; write 12:40Z for UTC or 12:40+01:00")
        if isinstance(moment, clock_time):
            today = datetime.fromtimestamp(now, moment.tzinfo).date()
            moment = datetime.combine(today, moment)
        return moment.timestamp()
