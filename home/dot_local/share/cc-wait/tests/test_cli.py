import io
import threading

import pytest

from cc_wait import cli
from cc_wait.builtins import BUILTINS
from cc_wait.source import SourceError


def test_budget_is_taken_out_wherever_it_appears():
    assert cli.split_budget(["file", "x", "--budget", "30", "--pid", "1"]) == (
        30.0,
        ["file", "x", "--pid", "1"],
    )
    assert cli.split_budget(["--budget=12.5", "exit"]) == (12.5, ["exit"])


def test_a_budget_that_is_not_a_positive_number_is_refused():
    with pytest.raises(SourceError, match="number of seconds"):
        cli.split_budget(["--budget", "soon", "file"])
    for raw in ("0", "-5"):
        with pytest.raises(SourceError, match="must be positive"):
            cli.split_budget([f"--budget={raw}", "file"])


def test_an_unknown_source_names_the_known_ones(tmp_path):
    out = io.StringIO()
    assert cli.main(["nope"], out=out, cwd=tmp_path, env={}) == 2
    assert "known here: file, exit" in out.getvalue()


def test_a_trailing_help_prints_the_built_in_s_option_help(tmp_path):
    for argv in (["file", "--help"], ["file", "x.log", "-h"]):
        out = io.StringIO()
        assert cli.main(argv, out=out, cwd=tmp_path, env={}) == 0
        text = out.getvalue()
        assert text.startswith("usage: cc-wait file ")
        assert "--match MATCH  success: a line matching this regex" in text
    # Every built-in answers it, not only `file`: each one's parser was built add_help=False.
    for name in BUILTINS:
        out = io.StringIO()
        assert cli.main([name, "--help"], out=out, cwd=tmp_path, env={}) == 0
        assert out.getvalue().startswith(f"usage: cc-wait {name}")


def test_a_source_s_help_names_the_budget_every_source_shares(tmp_path):
    out = io.StringIO()
    assert cli.main(["file", "--help"], out=out, cwd=tmp_path, env={}) == 0
    assert "--budget S     wait at most S seconds" in out.getvalue()


def test_a_timeout_the_source_refuses_is_pointed_at_budget(tmp_path):
    for flag in (["--timeout", "300"], ["--timeout=300"]):
        out = io.StringIO()
        argv = ["file", str(tmp_path / "x.log"), "--pid", "1", *flag]
        assert cli.main(argv, out=out, cwd=tmp_path, env={}) == 2
        assert "unrecognized arguments: --timeout" in out.getvalue()
        assert "cc-wait bounds every wait with --budget S, which exits 75" in out.getvalue()


def test_a_file_wait_ends_when_the_line_is_written(tmp_path):
    log = tmp_path / "land.log"
    log.write_text("merging\n")
    timer = threading.Timer(0.3, lambda: log.write_text("merging\nVERDICT: settled\n"))
    timer.start()
    out = io.StringIO()
    argv = [
        "file",
        str(log),
        "--match",
        "^VERDICT:",
        "--fail",
        "^Traceback",
        "--budget",
        "20",
    ]
    code = cli.main(argv, out=out, cwd=tmp_path, env={})
    timer.join()
    assert code == 0
    assert out.getvalue().splitlines()[-1] == "WAIT: matched VERDICT: settled"
