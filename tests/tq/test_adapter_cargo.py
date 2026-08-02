#!/usr/bin/env python3
"""cargo test's console output, which has no machine format to ask for."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import cargo as cargo_adapter
from helpers import (
    blank,
    by_name,
    read,
)


class TestCargoTestAdapter(unittest.TestCase):
    def test_totals_partition_the_run(self):
        res = cargo_adapter.parse_cargo_test(
            read("cargo-test-mixed.txt"), blank("cargo")
        )
        self.assertEqual(res.totals["tests"], 4)
        self.assertEqual(res.totals["pass"], 2)
        self.assertEqual(res.totals["fail"], 1)
        self.assertEqual(res.totals["skip"], 1)

    def test_failure_carries_the_panic_location_and_message(self):
        res = cargo_adapter.parse_cargo_test(
            read("cargo-test-mixed.txt"), blank("cargo")
        )
        fail = by_name(res, "tests::rejects_negative")
        self.assertEqual(fail.file, "src/lib.rs")
        self.assertEqual(fail.line, 42)
        self.assertIn("assertion `left == right` failed", fail.message)
        self.assertNotIn("panicked at", fail.message)

    def test_a_clean_run_has_no_failures(self):
        res = cargo_adapter.parse_cargo_test(
            read("cargo-test-clean.txt"), blank("cargo")
        )
        self.assertEqual(res.failures, [])
        self.assertEqual(res.totals["tests"], 3)
        self.assertEqual(res.totals["pass"], 3)

    def test_a_run_with_no_running_line_leaves_totals_at_zero(self):
        # A compile error before any test runs prints cargo's usual errors
        # instead of any test-shaped output — nothing here to parse, and the
        # empty totals are what let digest.py's NO TESTS RAN carry the verdict.
        res = cargo_adapter.parse_cargo_test(
            "error: could not compile `sample`", blank("cargo")
        )
        self.assertEqual(res.totals["tests"], 0)
        self.assertEqual(res.failures, [])

    def test_workspace_totals_are_summed_across_binaries(self):
        res = cargo_adapter.parse_cargo_test(
            read("cargo-test-workspace.txt"), blank("cargo")
        )
        self.assertEqual(res.totals["tests"], 4)
        self.assertEqual(res.totals["pass"], 2)
        self.assertEqual(res.totals["fail"], 2)

    def test_a_same_named_failure_in_a_later_binary_is_not_cross_attributed(self):
        # Both binaries have a failing "tests::shared"; each must keep its own
        # file, line and message rather than one clobbering or duplicating
        # the other's captured stdout block.
        res = cargo_adapter.parse_cargo_test(
            read("cargo-test-workspace.txt"), blank("cargo")
        )
        shared = [f for f in res.failures if f.name == "tests::shared"]
        self.assertEqual(len(shared), 2)
        by_file = {f.file: f for f in shared}
        self.assertEqual(by_file["crate_a/src/lib.rs"].line, 10)
        self.assertIn("crate a assertion failed", by_file["crate_a/src/lib.rs"].message)
        self.assertEqual(by_file["crate_b/src/lib.rs"].line, 20)
        self.assertIn("crate b assertion failed", by_file["crate_b/src/lib.rs"].message)


if __name__ == "__main__":
    unittest.main(verbosity=1)
