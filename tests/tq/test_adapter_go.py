#!/usr/bin/env python3
"""`go test -json`'s event stream."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import go as go_adapter
from helpers import (
    blank,
    by_name,
    ndjson,
    read,
)


class TestGoTestAdapter(unittest.TestCase):
    def setUp(self):
        self.res = go_adapter.parse_go_test(read("go-test-mixed.ndjson"), blank("go"))

    def test_totals_partition_the_run(self):
        self.assertEqual(self.res.totals["tests"], 3)
        self.assertEqual(self.res.totals["pass"], 2)
        self.assertEqual(self.res.totals["fail"], 1)
        self.assertEqual(self.res.totals["skip"], 0)

    def test_a_package_level_outcome_is_not_double_counted(self):
        # go-test-mixed.ndjson carries a package-level "fail" with no Test
        # field after TestSub's own — 3 tests, not 4.
        self.assertEqual(
            sum(self.res.totals[k] for k in ("pass", "fail", "skip")),
            self.res.totals["tests"],
        )

    def test_a_failing_tests_location_is_pulled_from_its_output(self):
        fail = by_name(self.res, "TestSub")
        self.assertEqual(fail.file, "sub_test.go")
        self.assertEqual(fail.line, 10)
        self.assertEqual(fail.message, "expected 2, got 3")

    def test_a_failing_tests_full_output_is_kept_as_stdout(self):
        fail = by_name(self.res, "TestSub")
        self.assertIn("=== RUN   TestSub", fail.stdout)
        self.assertIn("--- FAIL: TestSub", fail.stdout)

    def test_passing_tests_are_not_listed_as_failures(self):
        self.assertNotIn("TestAdd", [f.name for f in self.res.failures])
        self.assertNotIn("TestMul", [f.name for f in self.res.failures])

    def test_a_clean_run_has_no_failures(self):
        res = go_adapter.parse_go_test(read("go-test-clean.ndjson"), blank("go", 0))
        self.assertEqual(res.failures, [])
        self.assertEqual(res.totals["tests"], 2)
        self.assertEqual(res.totals["pass"], 2)

    def test_no_location_pattern_falls_back_to_the_raw_output(self):
        text = ndjson(
            [
                {"Action": "run", "Package": "m", "Test": "TestX"},
                {
                    "Action": "output",
                    "Package": "m",
                    "Test": "TestX",
                    "Output": "panic: boom, no location here\n",
                },
                {"Action": "fail", "Package": "m", "Test": "TestX"},
            ]
        )
        res = go_adapter.parse_go_test(text, blank("go"))
        fail = by_name(res, "TestX")
        self.assertIsNone(fail.file)
        self.assertIsNone(fail.line)
        self.assertEqual(fail.message, "panic: boom, no location here")

    def test_a_partial_final_line_does_not_lose_the_run(self):
        text = read("go-test-mixed.ndjson") + '{"Action":"output","Package":"m'
        res = go_adapter.parse_go_test(text, blank("go"))
        self.assertEqual(res.totals["tests"], self.res.totals["tests"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
