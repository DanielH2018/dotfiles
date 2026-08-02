#!/usr/bin/env python3
"""The CLI itself: flag splitting, retry, the prek splice, the raw tee."""

import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from digest import digest
from helpers import (
    blank,
    load_cli,
)
from result import Failure

PREK_OUTPUT = """Lint first-party Python (ruff)...........................Failed
- hook id: ruff
- exit code: 1

  scratch.py:1:1: F401 unused import os
  Found 1 error.
Run Python unit tests....................................................Failed
- hook id: pytest
- exit code: 1

  ============================= test session starts ====================
  collected 2 items
  test_scratch.py:6: AssertionError
  ========================= 1 failed, 1 passed in 0.15s ================
Shellcheck...............................................................Passed"""


class TestPrekSplice(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_only_the_pytest_block_is_replaced(self):
        text, replaced = self.cli.splice_prek(PREK_OUTPUT, "FAIL 1/2  0.1s")
        self.assertTrue(replaced)
        self.assertIn("  FAIL 1/2  0.1s", text)
        self.assertNotIn("test session starts", text)

    def test_another_hooks_failure_survives_the_splice(self):
        # Losing a ruff break behind the splice is the prek-shaped false pass.
        text, _ = self.cli.splice_prek(PREK_OUTPUT, "FAIL 1/2  0.1s")
        self.assertIn("- hook id: ruff", text)
        self.assertIn("F401 unused import os", text)
        self.assertIn("Found 1 error.", text)
        self.assertIn("Shellcheck...", text)

    def test_unrecognised_output_passes_through_untouched(self):
        # prek's block format is verified on 0.4.11 but CI pins 0.4.5; if the
        # markers are missing, hand the output over rather than guess at it.
        text, replaced = self.cli.splice_prek("some other tool's output\n", "FAIL 1/2")
        self.assertFalse(replaced)
        self.assertEqual(text, "some other tool's output\n")


class TestFlagSplit(unittest.TestCase):
    def test_tq_flags_are_taken_and_the_command_is_left_whole(self):
        cli = load_cli()
        opts, argv = cli.split_flags(["--scope=added", "ruff", "check", "."])
        self.assertEqual(opts["--scope"], "added")
        self.assertEqual(argv, ["ruff", "check", "."])

    def test_a_separated_value_is_accepted(self):
        cli = load_cli()
        opts, argv = cli.split_flags(["--scope", "file", "pytest"])
        self.assertEqual(opts["--scope"], "file")
        self.assertEqual(argv, ["pytest"])

    def test_parsing_stops_at_the_command(self):
        # The runner's own flags are the runner's, even when tq has a flag by
        # the same name — passthrough is what makes tq safe to sit in front of.
        cli = load_cli()
        opts, argv = cli.split_flags(["pytest", "--scope=added"])
        self.assertEqual(opts, {})
        self.assertEqual(argv, ["pytest", "--scope=added"])

    def test_a_bare_command_is_untouched(self):
        cli = load_cli()
        opts, argv = cli.split_flags(["node", "--test"])
        self.assertEqual(opts, {})
        self.assertEqual(argv, ["node", "--test"])


class TestFlaky(unittest.TestCase):
    def run_with(self, flaky_count, still_failing=0):
        res = blank("node")
        total = flaky_count + still_failing
        res.totals.update(tests=total + 1, fail=total, **{"pass": 1})
        res.duration_ms = 1800
        for i in range(flaky_count):
            res.failures.append(
                Failure(name=f"flaky{i}", file="a.test.js", line=i + 1, flaky=True)
            )
        for i in range(still_failing):
            res.failures.append(
                Failure(name=f"broken{i}", file="b.test.js", line=i + 1)
            )
        return res

    def test_a_flake_is_counted_in_the_headline(self):
        text = digest(self.run_with(flaky_count=1, still_failing=1), "/tmp/x.json")
        self.assertTrue(text.startswith("FAIL 2/3  (1 flaky)"))

    def test_a_flake_says_why_it_is_listed(self):
        text = digest(self.run_with(flaky_count=1), "/tmp/x.json")
        self.assertIn("FLAKY — failed, then passed on retry", text)

    def test_a_run_without_retry_says_nothing_about_flakiness(self):
        res = blank("node")
        res.totals.update(tests=2, fail=1, **{"pass": 1})
        res.failures.append(Failure(name="t", file="a.test.js", line=1))
        self.assertNotIn("flaky", digest(res, "/tmp/x.json").lower())

    def test_attempts_defaults_to_one(self):
        self.assertEqual(blank("node").attempts, 1)


class TestRetryFlagParsing(unittest.TestCase):
    def test_the_retry_switch_does_not_swallow_the_command(self):
        # Treating a valueless flag as if it took one would consume the program
        # name, leaving tq to run the runner's first argument as the runner.
        cli = load_cli()
        opts, argv = cli.split_flags(["--retry", "node", "--test"])
        self.assertIn("--retry", opts)
        self.assertEqual(argv, ["node", "--test"])

    def test_switches_and_valued_flags_mix(self):
        cli = load_cli()
        opts, argv = cli.split_flags(["--retry", "--scope=added", "pytest"])
        self.assertIn("--retry", opts)
        self.assertEqual(opts["--scope"], "added")
        self.assertEqual(argv, ["pytest"])

    def test_only_runners_that_name_their_own_failures_are_retried(self):
        # Rerunning a subset means asking the runner which subset. Guessing it
        # from a report is how a retry silently reruns the wrong tests.
        cli = load_cli()
        self.assertEqual(set(cli.RETRYABLE), {"node", "pytest"})


class TestRawTee(unittest.TestCase):
    """The runner's own bytes, kept when the run went wrong.

    Everything else tq writes is what an adapter made of the output, and this
    review found several adapters that were confidently wrong. A miscounted
    total looks exactly like a correct one; the original settles it.
    """

    class Proc:
        def __init__(self, out="", err=""):
            self.stdout = out
            self.stderr = err
            self.returncode = 1

    def setUp(self):
        self.cli = load_cli()
        self.dir = tempfile.mkdtemp(prefix="tq-raw-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.json_path = os.path.join(self.dir, "out.json")

    def test_both_streams_are_kept_verbatim(self):
        path = self.cli.tee_raw(
            self.Proc("stdout here\n", "stderr here\n"), self.json_path
        )
        self.assertEqual(path, f"{self.json_path}.raw")
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "stdout here\nstderr here\n")

    def test_nothing_is_written_when_the_runner_said_nothing(self):
        self.assertEqual(self.cli.tee_raw(self.Proc("", "  \n"), self.json_path), "")
        self.assertFalse(os.path.exists(f"{self.json_path}.raw"))

    def test_an_unwritable_target_does_not_take_the_digest_down(self):
        blocked = os.path.join(self.dir, "nope", "out.json")
        self.assertEqual(self.cli.tee_raw(self.Proc("x"), blocked), "")


if __name__ == "__main__":
    unittest.main(verbosity=1)
