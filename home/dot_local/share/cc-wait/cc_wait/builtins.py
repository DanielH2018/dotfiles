"""The sources every repo gets: `file` and `exit`.

Both require a way to see failure, not only success. `file` takes `--fail` or `--pid`, and
`exit` reads a recorded exit code, so neither can wait out its whole budget on a writer that
already died.
"""

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path

from cc_wait import github
from cc_wait.source import Description, ReadError, Reading, SourceError


class _Parser(argparse.ArgumentParser):
    """An argument parser that raises SourceError instead of exiting the process."""

    def error(self, message):
        raise SourceError(f"{self.prog}: {message}\n{self.format_usage().strip()}")


def pid_alive(pid: int) -> bool:
    """Whether a process with `pid` exists. Signal 0 checks without delivering anything."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # It exists and belongs to another user.
        return True
    return True


@dataclass(frozen=True)
class FileWait:
    path: Path
    match: re.Pattern | None
    fail: re.Pattern | None
    pid: int | None

    def describe(self) -> Description:
        terminal = {"matched" if self.match else "present": 0}
        if self.fail:
            terminal["failed"] = 1
        if self.pid is not None:
            terminal["writer-exited"] = 1
        return Description(terminal=terminal, watch=(str(self.path),), interval_s=5.0)

    def read(self) -> Reading:
        # The writer's liveness is read BEFORE the file, so a line it wrote just before it
        # exited is always seen: the order rules out reporting writer-exited over a match.
        writer_alive = self.pid is None or pid_alive(self.pid)
        found = self._scan()
        if found:
            return found
        if not writer_alive:
            return Reading("writer-exited", f"pid {self.pid} exited with no matching line")
        return Reading("waiting" if self.match else "absent", str(self.path))

    def _scan(self) -> Reading | None:
        if not self.match:
            return Reading("present", str(self.path)) if self.path.exists() else None
        try:
            text = self.path.read_text(errors="replace")
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise ReadError(f"cannot read {self.path}: {exc}") from exc
        # The first line to match either pattern decides, as it would for a reader of the log.
        for line in text.splitlines():
            if self.fail and self.fail.search(line):
                return Reading("failed", line.strip())
            if self.match.search(line):
                return Reading("matched", line.strip())
        return None


class FileSource:
    name = "file"
    summary = "a path appears, or a line matching --match is written to it"

    def bind(self, args: list[str]) -> FileWait:
        parser = _Parser(prog="cc-wait file", add_help=False)
        parser.add_argument("path")
        parser.add_argument("--match", help="success: a line matching this regex")
        parser.add_argument("--fail", help="failure: a line matching this regex")
        parser.add_argument("--pid", type=int, help="failure: this writer exits first")
        ns = parser.parse_args(args)
        if ns.fail is None and ns.pid is None:
            parser.error("give --fail, --pid or both: a wait must be able to see its writer fail")
        if ns.fail is not None and ns.match is None:
            parser.error("--fail reads lines, so it needs --match for the success line")
        try:
            match = re.compile(ns.match) if ns.match is not None else None
            fail = re.compile(ns.fail) if ns.fail is not None else None
        except re.error as exc:
            raise SourceError(f"cc-wait file: bad regex: {exc}") from exc
        return FileWait(Path(ns.path), match, fail, ns.pid)


@dataclass(frozen=True)
class ExitWait:
    rc_file: Path
    pid: int | None

    def describe(self) -> Description:
        return Description(
            terminal={"succeeded": 0, "failed": 1, "died": 1},
            watch=(str(self.rc_file),),
            interval_s=5.0,
        )

    def read(self) -> Reading:
        # Liveness first, then the file, for the same reason as FileWait.read: a process
        # writes its code and then exits, so a dead pid with no file means it was killed.
        alive = self.pid is None or pid_alive(self.pid)
        try:
            raw = self.rc_file.read_text().strip()
        except FileNotFoundError:
            if not alive:
                return Reading("died", f"pid {self.pid} exited without writing {self.rc_file}")
            return Reading("running", str(self.rc_file))
        except OSError as exc:
            raise ReadError(f"cannot read {self.rc_file}: {exc}") from exc
        if raw == "0":
            return Reading("succeeded", "exit code 0")
        return Reading("failed", f"exit code {raw or '(empty)'}")


class ExitSource:
    name = "exit"
    summary = (
        "a process records its exit code in --rc-file (and --pid, if given, is alive until then)"
    )

    def bind(self, args: list[str]) -> ExitWait:
        parser = _Parser(prog="cc-wait exit", add_help=False)
        parser.add_argument("--rc-file", required=True)
        parser.add_argument("--pid", type=int, help="the process that writes --rc-file")
        ns = parser.parse_args(args)
        return ExitWait(Path(ns.rc_file), ns.pid)


BUILTINS = {
    source.name: source
    for source in (FileSource(), ExitSource(), github.PrSource(), github.CiSource())
}
