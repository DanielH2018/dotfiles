import shutil
import subprocess
import threading
import time

import pytest

from cc_wait.watch import wait_for_change


@pytest.mark.skipif(shutil.which("inotifywait") is None, reason="needs inotifywait")
def test_a_write_wakes_the_wait_before_its_timeout(tmp_path):
    target = tmp_path / "rc"
    timer = threading.Timer(0.5, target.write_text, args=("0\n",))
    timer.start()
    started = time.monotonic()
    wait_for_change([str(target)], 20)
    timer.join()
    assert time.monotonic() - started < 10


def test_with_no_watcher_installed_it_sleeps_the_whole_timeout(tmp_path):
    slept = []
    wait_for_change(
        [str(tmp_path)], 7, which=lambda _name: None, sleep=slept.append, clock=lambda: 0.0
    )
    assert slept == [7]


def test_a_watcher_that_errors_falls_back_to_sleeping(tmp_path):
    slept = []

    def broken(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 1)

    wait_for_change(
        [str(tmp_path)],
        7,
        which=lambda name: f"/usr/bin/{name}",
        run=broken,
        sleep=slept.append,
        clock=lambda: 0.0,
    )
    assert slept == [7]
