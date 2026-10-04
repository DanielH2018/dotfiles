"""The `systemd` source: a unit finishes starting, or a oneshot unit's run finishes.

`cc-wait systemd <unit> [--user]` reads `systemctl show` and ends on the unit's own verdict:

    active      0   the unit is up (any type but a plain oneshot)
    succeeded   0   a oneshot without RemainAfterExit ran and exited cleanly
    failed      1   ActiveState is `failed`, or the last Result is not `success`
    stopped     1   a unit that should stay up is inactive with nothing queued, or a oneshot
                    that has not run since it was loaded and has nothing queued

A unit with a queued job, or one activating, deactivating or reloading, is still running.
The queued job matters: right after `systemctl start --no-block`, the unit still reads
`inactive` with `Result=success`, and only `Job=` says a run is on its way.

A WAIT STARTED AFTER THE RUN ENDED reports that run's verdict at once. The source cannot tell
"the run you meant" from "the previous run" without a baseline, and a baseline taken when the
wait starts is lost when the wait is re-run. So the detail carries the time the unit entered
its state, and the caller judges whether that is the run it meant.

A unit systemd has not loaded (not-found, masked, a bad unit file) cannot be waited on. A
missing unit reads `inactive` with `Result=success`, which would otherwise pass for a clean run.
So does a oneshot that is loaded but has never run, such as a timer's unit before the timer
first fires. Only its empty `ExecMainStartTimestamp` tells it apart, so the source reads that
before it reports `succeeded`.
"""

import os
import re
import shutil
import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from cc_wait.source import ArgParser, Description, ReadError, Reading, SourceError

PROPERTIES = (
    "LoadState",
    "ActiveState",
    "SubState",
    "Result",
    "Type",
    "RemainAfterExit",
    "Job",
    "StateChangeTimestamp",
    "ExecMainStartTimestamp",
    "ExecMainExitTimestamp",
)
TRANSITIONAL = frozenset({"activating", "deactivating", "reloading", "refreshing", "maintenance"})
SYSTEMCTL_TIMEOUT_S = 10
# A leading `-` would read as an option to systemctl.
_UNIT = re.compile(r"^[A-Za-z0-9:_.@\\][A-Za-z0-9:_.@\\-]*$")

Runner = Callable[..., subprocess.CompletedProcess]


def user_env(environ: Mapping[str, str]) -> dict[str, str] | None:
    """The environment `systemctl --user` needs to find the user's bus, or None to inherit.

    A session started outside a login (a Remote Control bridge, cron) has no XDG_RUNTIME_DIR,
    and `systemctl --user` then fails with "Failed to connect to bus: No medium found".
    """
    if environ.get("XDG_RUNTIME_DIR"):
        return None
    runtime = f"/run/user/{os.getuid()}"
    return {**environ, "XDG_RUNTIME_DIR": runtime} if os.path.isdir(runtime) else None


@dataclass(frozen=True)
class UnitWait:
    unit: str
    user: bool
    run: Runner = field(default=subprocess.run, compare=False, repr=False)

    def describe(self) -> Description:
        return Description(terminal={"active": 0, "succeeded": 0, "failed": 1, "stopped": 1})

    def _show(self) -> dict[str, str]:
        cmd = ["systemctl", *(["--user"] if self.user else []), "show", self.unit]
        cmd += ["--property", ",".join(PROPERTIES)]
        try:
            out = self.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=SYSTEMCTL_TIMEOUT_S,
                check=False,
                env=user_env(os.environ) if self.user else None,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ReadError(f"systemctl did not run: {exc}") from exc
        if out.returncode != 0:
            raise ReadError(f"systemctl show exited {out.returncode}: {out.stderr.strip()[-300:]}")
        # systemd prints properties in its own order, not the order asked for.
        return dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)

    def read(self) -> Reading:
        props = self._show()
        load = props.get("LoadState", "")
        if load != "loaded":
            raise ReadError(f"{self.unit} is not loaded (LoadState={load or 'missing'})")
        active, sub = props.get("ActiveState", ""), props.get("SubState", "")
        result = props.get("Result", "")
        since = props.get("StateChangeTimestamp") or "an unknown time"
        state = f"{active}/{sub}"
        # A oneshot's start job lasts its whole run, so the state names an activating unit
        # better than its job does; the job matters only on a unit that has not started.
        if active in TRANSITIONAL:
            return Reading("running", f"{state} since {since}")
        if props.get("Job"):
            return Reading("running", f"{state}, job {props['Job']} queued")
        if active == "failed" or result not in ("success", ""):
            return Reading("failed", f"{state}, result {result} since {since}")
        if active == "active":
            return Reading("active", f"{state} since {since}")
        oneshot = props.get("Type") == "oneshot" and props.get("RemainAfterExit") != "yes"
        if active == "inactive" and oneshot:
            # Measured: apt-daily-upgrade.service, loaded and never run, read inactive with
            # Result=success and a StateChangeTimestamp from when it was loaded.
            if not props.get("ExecMainStartTimestamp"):
                return Reading(
                    "stopped", f"{state}: has not run since it was loaded, nothing queued"
                )
            ended = props.get("ExecMainExitTimestamp") or since
            return Reading("succeeded", f"last run ended {ended}")
        return Reading("stopped", f"{state} since {since}, nothing queued")


class UnitSource:
    name = "systemd"
    summary = "a systemd unit is up or its oneshot run succeeded (0), or it failed (1)"

    def bind(self, args: list[str]) -> UnitWait:
        parser = ArgParser(prog="cc-wait systemd", add_help=False)
        parser.add_argument("unit")
        parser.add_argument("--user", action="store_true", help="a unit of the user's manager")
        ns = parser.parse_args(args)
        if not _UNIT.match(ns.unit):
            parser.error(f"{ns.unit!r} is not a unit name")
        if shutil.which("systemctl") is None:
            raise SourceError("cc-wait systemd: no systemctl on PATH; this host has no systemd")
        return UnitWait(ns.unit, ns.user)
