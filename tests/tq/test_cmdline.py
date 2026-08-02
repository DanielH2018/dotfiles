#!/usr/bin/env python3
"""The argv surgery every runner does before it runs."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import cmdline
from helpers import (
    load_cli,
    survey_blank,
)
from result import Item
from runners import git as git_runner
from runners import survey as survey_runner


class TestSurveyFlags(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_format_flags_are_dropped_without_eating_their_neighbour(self):
        # drop_flag() assumes a flag takes a value and skips the token after it.
        # These take none, so the same helper would swallow the pathspec.
        self.assertEqual(
            cmdline.drop_switches(
                ["git", "log", "--oneline", "-40", "src"], git_runner.LOG_FORMATS
            ),
            ["git", "log", "-40", "src"],
        )
        self.assertEqual(
            cmdline.drop_switches(
                ["git", "diff", "--stat", "HEAD"], git_runner.DIFF_FORMATS
            ),
            ["git", "diff", "HEAD"],
        )

    def test_a_pathspec_past_the_separator_is_a_path_not_a_flag(self):
        self.assertEqual(
            cmdline.drop_switches(
                ["git", "log", "--oneline", "--", "--stat"], git_runner.LOG_FORMATS
            ),
            ["git", "log", "--", "--stat"],
        )

    def test_a_limit_is_recorded_only_when_the_command_reached_it(self):
        self.assertEqual(
            cmdline.count_limit(["git", "log", "-n", "50"], ("-n",)), (50, "-n 50")
        )
        self.assertEqual(
            cmdline.count_limit(["git", "log", "-5"], ("-n",), bare=True), (5, "-5")
        )
        self.assertEqual(cmdline.count_limit(["git", "log"], ("-n",)), (None, ""))

        # A log capped at 50 that found 12 was not capped by anything: there
        # were 12. Saying "there may be more" then would invent a tail.
        short = survey_blank("commits")
        short.items = [Item(sha="a")] * 12
        survey_runner.note_limit(short, 50, "-n 50")
        self.assertEqual(short.limited, "")

        at_cap = survey_blank("commits")
        at_cap.items = [Item(sha="a")] * 50
        survey_runner.note_limit(at_cap, 50, "-n 50")
        self.assertEqual(at_cap.limited, "-n 50")


if __name__ == "__main__":
    unittest.main(verbosity=1)
