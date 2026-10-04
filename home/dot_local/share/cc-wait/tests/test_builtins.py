import os
import subprocess

import pytest

from cc_wait.builtins import ExitSource, FileSource
from cc_wait.source import SourceError, validate


@pytest.fixture
def dead_pid():
    proc = subprocess.Popen(["true"])
    proc.wait()
    return proc.pid


def file_wait(*args):
    bound = FileSource().bind([str(a) for a in args])
    validate(bound.describe())
    return bound


def test_file_a_matching_line_is_matched(tmp_path):
    log = tmp_path / "log"
    log.write_text("starting\nVERDICT: settled\n")
    reading = file_wait(log, "--match", "^VERDICT:", "--fail", "^Traceback").read()
    assert (reading.state, reading.detail) == ("matched", "VERDICT: settled")


def test_file_the_first_terminal_line_decides(tmp_path):
    log = tmp_path / "log"
    log.write_text("Traceback (most recent call last):\nVERDICT: settled\n")
    reading = file_wait(log, "--match", "^VERDICT:", "--fail", "^Traceback").read()
    assert reading.state == "failed"


def test_file_a_writer_that_exits_without_the_line_is_a_failure(tmp_path, dead_pid):
    log = tmp_path / "log"
    log.write_text("starting\n")
    reading = file_wait(log, "--match", "^VERDICT:", "--pid", dead_pid).read()
    assert reading.state == "writer-exited"


def test_file_a_missing_file_with_a_live_writer_is_still_waiting(tmp_path):
    # This process is the live writer, so pid_alive must answer True for the wait to stay open.
    reading = file_wait(tmp_path / "log", "--match", "^VERDICT:", "--pid", os.getpid()).read()
    assert reading.state == "waiting"


def test_file_without_a_way_to_see_failure_is_refused(tmp_path):
    with pytest.raises(SourceError, match="--fail, --pid"):
        FileSource().bind([str(tmp_path / "log"), "--match", "^done"])


def exit_wait(rc_file, pid=None):
    args = ["--rc-file", str(rc_file)] + (["--pid", str(pid)] if pid else [])
    return ExitSource().bind(args)


def test_exit_a_zero_code_succeeded(tmp_path):
    (tmp_path / "rc").write_text("0\n")
    assert exit_wait(tmp_path / "rc").read().state == "succeeded"


def test_exit_a_non_zero_code_failed(tmp_path):
    (tmp_path / "rc").write_text("3\n")
    reading = exit_wait(tmp_path / "rc").read()
    assert (reading.state, reading.detail) == ("failed", "exit code 3")


def test_exit_a_dead_process_with_no_code_died(tmp_path, dead_pid):
    assert exit_wait(tmp_path / "rc", dead_pid).read().state == "died"


def test_exit_no_code_yet_is_running(tmp_path):
    assert exit_wait(tmp_path / "rc").read().state == "running"
