#!/usr/bin/env python3
"""node --test's reporter stream, via tq's own reporter."""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import node as node_adapter
from helpers import (
    blank,
    by_name,
    fixture,
    read,
    write_ndjson,
)


class TestNodeAdapter(unittest.TestCase):
    def setUp(self):
        self.res = node_adapter.parse(fixture("node-events.ndjson"), blank("node"))

    def test_todo_splits_into_xfail_and_xpass(self):
        # node counts a todo test as todo whether it passed or failed, so the
        # two halves partition cleanly — unlike JUnit, which cannot see an xpass.
        self.assertEqual(self.res.totals["xfail"], 1)
        self.assertEqual(self.res.totals["xpass"], 1)
        totals = self.res.totals
        self.assertEqual(
            sum(totals[k] for k in ("pass", "fail", "skip", "xfail", "xpass")),
            totals["tests"],
        )

    def test_todo_failure_is_not_listed_as_a_failure(self):
        self.assertNotIn("known broken", [f.name for f in self.res.failures])

    def test_assertion_points_at_the_assert_not_the_test_declaration(self):
        fail = by_name(self.res, "compares values")
        self.assertEqual(fail.file, "/sample/unit.test.js")
        self.assertEqual(fail.line, 7)
        self.assertIn("boom mismatch", fail.message)

    def test_subprocess_output_is_attributed_to_the_test(self):
        fail = by_name(self.res, "shells out")
        self.assertIn("rendered diff:", fail.stdout)
        self.assertEqual(fail.scope, "")

    def test_file_level_output_is_labelled_as_file_scoped(self):
        fail = by_name(self.res, "compares values")
        self.assertIn("config key missing", fail.stdout)
        self.assertEqual(fail.scope, "file")

    def test_top_level_assert_crash_is_distilled(self):
        # node reports these only as "test failed"; the detail is in the file's
        # stderr, wrapped in a throw-site preamble and eight internal frames.
        fail = by_name(self.res, "toplevel.test.js")
        self.assertEqual(fail.line, 3)
        self.assertIn("top level assert failed", fail.message)
        self.assertNotIn("node:internal", fail.message)
        self.assertNotIn("Node.js v", fail.message)
        self.assertTrue(fail.recovered)

    def test_a_partial_final_line_does_not_lose_the_run(self):
        import tempfile

        text = read("node-events.ndjson") + '{"t":"fail","file":"/sample/x'
        with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False) as fh:
            fh.write(text)
        try:
            res = node_adapter.parse(fh.name, blank("node"))
            self.assertEqual(res.totals["tests"], self.res.totals["tests"])
        finally:
            os.unlink(fh.name)

    def test_a_subprocess_scoped_failure_does_not_swallow_the_next_files_stream(self):
        # A failure carrying error.stdout/error.stderr takes its own streams and
        # never reads streams["out"]/["err"] for its file — so it must not mark
        # that file as charged, or a later file-scoped failure in the same file
        # finds the shared stream already spent and reports it empty.
        path = write_ndjson(
            [
                {"t": "out", "file": "/sample/a.test.js", "text": "file stdout\n"},
                {"t": "err", "file": "/sample/a.test.js", "text": "file stderr\n"},
                {
                    "t": "fail",
                    "file": "/sample/a.test.js",
                    "name": "first",
                    "error": {
                        "name": "Error",
                        "message": "boom1",
                        "stdout": "proc stdout",
                        "stderr": "proc stderr",
                    },
                },
                {
                    "t": "fail",
                    "file": "/sample/a.test.js",
                    "name": "second",
                    "error": {"name": "Error", "message": "boom2"},
                },
                {
                    "t": "summary",
                    "counts": {"tests": 2, "failed": 2},
                    "duration_ms": 1,
                },
            ]
        )
        try:
            res = node_adapter.parse(path, blank("node"))
        finally:
            os.unlink(path)
        second = by_name(res, "second")
        self.assertEqual(second.stdout, "file stdout\n")
        self.assertEqual(second.stderr, "file stderr\n")


class TestNodeSummaryTotals(unittest.TestCase):
    def test_per_file_summaries_are_added_up_not_sampled(self):
        # With no run-level summary the last file's counts used to stand in for
        # the run, which reads as a small green suite next to a long red one.
        result = blank("node")
        records = [
            {"t": "summary", "file": "a.test.js", "counts": {"tests": 9, "failed": 2}},
            {"t": "summary", "file": "b.test.js", "counts": {"tests": 3, "failed": 0}},
        ]
        path = os.path.join(tempfile.mkdtemp(prefix="tq-node-"), "out.ndjson")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("\n".join(json.dumps(rec) for rec in records))
        node_adapter.parse(path, result)
        self.assertEqual(result.totals["tests"], 12)
        self.assertEqual(result.totals["fail"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
