"""What a wait source is: its terminal states, and one read of its state.

Every source, built-in or a repo's `.claude/wait-sources/<name>`, is bound to its arguments
once and then answers two questions. `describe()` says which states end the wait and the exit
code each ends it with, which paths to watch for a change, and how often to look otherwise.
`read()` returns the state right now. The loop in `cc_wait.loop` owns everything else, so no
source carries a loop of its own.
"""

import argparse
import json
import math
from dataclasses import dataclass
from typing import Protocol

# cc-wait's own exit codes. A source may not declare either one: 75 must always mean "re-run
# this same cc-wait command", and 2 must always mean "cc-wait could not wait at all". A landing
# that exits 75 itself means "re-run land.sh", so its probe remaps that code.
COULD_NOT_WAIT = 2
BUDGET_ELAPSED = 75
RESERVED = frozenset({COULD_NOT_WAIT, BUDGET_ELAPSED})


class SourceError(Exception):
    """A source cc-wait refuses to wait on: unknown, malformed or misdeclared."""


class ReadError(Exception):
    """One read of a source's state failed. The loop retries it."""


class ArgParser(argparse.ArgumentParser):
    """A source's argument parser: it raises SourceError where argparse would exit."""

    def error(self, message):
        raise SourceError(f"{self.prog}: {message}\n{self.format_usage().strip()}")


@dataclass(frozen=True)
class Description:
    """What ends a wait on one bound source, and how to watch it.

    Attributes:
      terminal: each state that ends the wait, mapped to the exit code it ends it with.
      watch: paths whose change should trigger a re-read before the interval elapses.
      interval_s: the longest gap between two reads.
      remote: whether a read calls a remote API.
    """

    terminal: dict[str, int]
    watch: tuple[str, ...] = ()
    interval_s: float = 5.0
    remote: bool = False


@dataclass(frozen=True)
class Reading:
    """One observation of a source: a state word and a line of detail for the operator."""

    state: str
    detail: str = ""


class Bound(Protocol):
    """A source bound to its arguments.

    Its repr must name the source and its arguments and nothing process-specific: cc-wait keys
    the cache a remote source's reads are shared through on it (`cc_wait.cache`). A frozen
    dataclass with no callable in its repr meets that.
    """

    def describe(self) -> Description: ...

    def read(self) -> Reading: ...


class Source(Protocol):
    """A named kind of wait. `bind` raises SourceError on arguments it cannot use."""

    name: str
    summary: str

    def bind(self, args: list[str]) -> Bound: ...


def validate(desc: Description) -> Description:
    """Return `desc` unchanged, or raise SourceError naming why cc-wait refuses it.

    The failure-state rule is Monitor's "silence is not success" enforced once: a source that
    can only end in success reads a crash as "still waiting" until the budget runs out.
    """
    if not desc.terminal:
        raise SourceError("it declares no terminal state, so nothing could end the wait")
    for state, code in desc.terminal.items():
        if isinstance(code, bool) or not isinstance(code, int) or not 0 <= code <= 255:
            raise SourceError(f"state {state!r} declares exit code {code!r}, not an int in 0-255")
    reserved = sorted(state for state, code in desc.terminal.items() if code in RESERVED)
    if reserved:
        raise SourceError(
            f"it declares a reserved exit code ({COULD_NOT_WAIT} or {BUDGET_ELAPSED}) for "
            f"{', '.join(reserved)}; those belong to cc-wait"
        )
    if all(code == 0 for code in desc.terminal.values()):
        raise SourceError(
            "it declares no failure state (a terminal state with a non-zero exit code), so a "
            "crash would read as still waiting"
        )
    if not math.isfinite(desc.interval_s) or desc.interval_s <= 0:
        raise SourceError(f"its interval {desc.interval_s!r} is not a positive number")
    return desc


def description_from_json(text: str) -> Description:
    """Parse a repo probe's `--describe` output, or raise SourceError."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise SourceError(f"its --describe output is not JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SourceError("its --describe output is not a JSON object")
    terminal = data.get("terminal")
    if not isinstance(terminal, dict):
        raise SourceError("its --describe output has no `terminal` object")
    watch = data.get("watch", [])
    if not isinstance(watch, list) or not all(isinstance(p, str) for p in watch):
        raise SourceError("its --describe `watch` is not a list of paths")
    interval = data.get("interval_s", 5.0)
    if isinstance(interval, bool) or not isinstance(interval, int | float):
        raise SourceError("its --describe `interval_s` is not a number")
    return Description(
        terminal=dict(terminal),
        watch=tuple(watch),
        interval_s=float(interval),
        remote=bool(data.get("remote", False)),
    )


def reading_from_json(text: str) -> Reading:
    """Parse one line of a repo probe's state, or raise ReadError."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise ReadError(f"its output is not JSON: {text.strip()[:200]!r}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("state"), str) or not data["state"]:
        raise ReadError(f"its output has no `state` string: {text.strip()[:200]!r}")
    detail = data.get("detail", "")
    return Reading(state=data["state"], detail=detail if isinstance(detail, str) else str(detail))
