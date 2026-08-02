#!/usr/bin/env python3
"""The subprocess call itself, against a real child."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import process


class TestRunTimeout(unittest.TestCase):
    """`run()` against a real child, because the trap here is in what CPython
    hands back on a kill, not in anything tq computes."""

    def sleeper(self):
        return [
            sys.executable,
            "-c",
            "import sys, time; print('ran a bit'); sys.stdout.flush(); time.sleep(30)",
        ]

    def setUp(self):
        self.timeout = process.TIMEOUT

    def tearDown(self):
        process.TIMEOUT = self.timeout

    def test_a_killed_runner_yields_its_partial_output_as_text(self):
        process.TIMEOUT = 1
        proc, timed_out = process.run(self.sleeper(), os.environ.copy())
        self.assertTrue(timed_out)
        self.assertEqual(proc.returncode, 124)
        # TimeoutExpired carries bytes even under text=True, and no returncode
        # at all — both have to be normalised or the digest blows up on a hang.
        self.assertIsInstance(proc.stdout, str)
        self.assertIn("ran a bit", proc.stdout)

    def test_a_runner_that_finishes_is_not_marked_timed_out(self):
        process.TIMEOUT = 30
        proc, timed_out = process.run(
            [sys.executable, "-c", "print('done')"], os.environ.copy()
        )
        self.assertFalse(timed_out)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("done", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
