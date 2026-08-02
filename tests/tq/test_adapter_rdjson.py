#!/usr/bin/env python3
"""rdjson, for tools reached through --ingest."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import rdjson as rdjson_adapter
from helpers import (
    blank,
    by_name,
    read,
)


class TestRdjson(unittest.TestCase):
    def setUp(self):
        self.res = rdjson_adapter.parse(read("ruff-rdjson.json"), blank("ruff"))
        self.res.kind = "lint"

    def test_a_tool_tq_has_never_met_still_digests(self):
        self.assertEqual(len(self.res.failures), 2)
        fail = by_name(self.res, "F401")
        self.assertEqual((fail.line, fail.column), (1, 8))
        self.assertEqual(fail.source, "ruff")
        self.assertIn("unused-import", fail.code_url)

    def test_a_run_level_severity_reaches_every_finding(self):
        # rdjson may state severity once at the top rather than per diagnostic.
        self.assertTrue(all(f.severity == "warning" for f in self.res.failures))

    def test_a_suggestion_is_never_claimed_to_be_safe(self):
        # rdjson states the edit but not whether applying it is safe, and tq
        # must not upgrade silence into a promise.
        self.assertTrue(all(f.fixable == "unsafe" for f in self.res.failures))

    def test_output_that_is_not_rdjson_leaves_the_result_alone(self):
        self.assertEqual(rdjson_adapter.parse("<html>", blank("x")).failures, [])
        self.assertEqual(rdjson_adapter.parse("[1,2]", blank("x")).failures, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
