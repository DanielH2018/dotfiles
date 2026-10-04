"""`systemd` against a fake `systemctl show`: unit properties in, a state out."""

import subprocess

import pytest

from cc_wait import systemd
from cc_wait.source import ReadError, SourceError, validate

ONESHOT = {"Type": "oneshot", "RemainAfterExit": "no", "LoadState": "loaded"}
SIMPLE = {"Type": "simple", "RemainAfterExit": "no", "LoadState": "loaded"}


def show(props: dict[str, str], calls: list | None = None):
    """A runner printing `props` as `systemctl show` does: Key=Value, in its own order."""

    def run(cmd, **_kwargs):
        if calls is not None:
            calls.append(cmd)
        text = "".join(f"{k}={v}\n" for k, v in reversed(list(props.items())))
        return subprocess.CompletedProcess(cmd, 0, text, "")

    return run


def read(props, **kwargs):
    wait = systemd.UnitWait("tick.service", kwargs.get("user", False), show(props))
    validate(wait.describe())
    return wait.read()


def test_a_oneshot_that_ran_cleanly_succeeded_and_says_when():
    props = {
        **ONESHOT,
        "ActiveState": "inactive",
        "SubState": "dead",
        "Result": "success",
        "StateChangeTimestamp": "Sun 2026-10-04 17:40:01 UTC",
        "ExecMainStartTimestamp": "Sun 2026-10-04 17:39:12 UTC",
        "ExecMainExitTimestamp": "Sun 2026-10-04 17:40:01 UTC",
    }
    reading = read(props)
    assert reading.state == "succeeded"
    assert "17:40:01" in reading.detail


def test_a_oneshot_that_never_ran_is_not_a_clean_run():
    """Measured on apt-daily-upgrade.service: loaded, never run, Result=success."""
    props = {
        **ONESHOT,
        "ActiveState": "inactive",
        "SubState": "dead",
        "Result": "success",
        "StateChangeTimestamp": "Sun 2026-10-04 15:51:10 UTC",
        "ExecMainStartTimestamp": "",
    }
    reading = read(props)
    assert reading.state == "stopped"
    assert "has not run" in reading.detail


def test_a_queued_start_job_keeps_an_inactive_unit_running():
    """Right after `systemctl start --no-block`, only Job= says a run is coming."""
    props = {
        **ONESHOT,
        "ActiveState": "inactive",
        "SubState": "dead",
        "Result": "success",
        "Job": "148153",
    }
    assert read(props).state == "running"


def test_an_activating_unit_is_running():
    props = {**ONESHOT, "ActiveState": "activating", "SubState": "start", "Result": "success"}
    assert read(props).state == "running"


def test_a_failed_unit_fails_with_its_result():
    props = {**ONESHOT, "ActiveState": "failed", "SubState": "failed", "Result": "exit-code"}
    reading = read(props)
    assert reading.state == "failed"
    assert "exit-code" in reading.detail


def test_an_auto_restart_after_a_failure_is_still_running():
    props = {
        **SIMPLE,
        "ActiveState": "activating",
        "SubState": "auto-restart",
        "Result": "exit-code",
    }
    assert read(props).state == "running"


def test_a_service_that_came_up_is_active():
    props = {**SIMPLE, "ActiveState": "active", "SubState": "running", "Result": "success"}
    assert read(props).state == "active"


def test_a_service_that_should_stay_up_but_is_inactive_is_stopped():
    props = {**SIMPLE, "ActiveState": "inactive", "SubState": "dead", "Result": "success"}
    assert read(props).state == "stopped"


def test_a_missing_unit_is_not_read_as_a_clean_run():
    """Measured: systemctl show of a missing unit prints ActiveState=inactive, Result=success."""
    props = {
        "LoadState": "not-found",
        "ActiveState": "inactive",
        "Result": "success",
        "Type": "oneshot",
    }
    with pytest.raises(ReadError, match="not-found"):
        read(props)


def test_user_asks_the_user_manager():
    calls: list = []
    systemd.UnitWait("x.service", True, show({**SIMPLE, "ActiveState": "active"}, calls)).read()
    assert calls[0][:3] == ["systemctl", "--user", "show"]


def test_a_user_wait_finds_the_bus_when_the_session_has_no_runtime_dir(monkeypatch):
    """Measured: a bridge session has no XDG_RUNTIME_DIR, and systemctl --user then fails."""
    monkeypatch.setattr(systemd.os.path, "isdir", lambda path: path.startswith("/run/user/"))
    env = systemd.user_env({"PATH": "/usr/bin"})
    assert env is not None and env["XDG_RUNTIME_DIR"].startswith("/run/user/")
    assert systemd.user_env({"XDG_RUNTIME_DIR": "/run/user/7"}) is None


def test_bind_refuses_a_name_systemctl_would_read_as_an_option():
    with pytest.raises(SourceError, match="not a unit name"):
        systemd.UnitSource().bind(["--", "--now"])
