#!/usr/bin/env python3
"""pytest's JUnit XML, and the same reader over Gradle's and Maven's."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import junit as junit_adapter
from digest import digest
from helpers import (
    blank,
    by_name,
    fixture,
    read,
)


class TestJUnitAdapter(unittest.TestCase):
    def test_totals_partition_the_run(self):
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        self.assertEqual(res.totals["tests"], 4)
        self.assertEqual(res.totals["fail"], 2)
        self.assertEqual(res.totals["skip"], 1)
        self.assertEqual(res.totals["pass"], 1)
        self.assertEqual(
            sum(res.totals[k] for k in ("pass", "fail", "skip", "xfail", "xpass")), 4
        )

    def test_failure_carries_location_and_assertion(self):
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        fail = by_name(res, "test_fails_with_output")
        self.assertEqual(fail.file, "test_fail.py")
        self.assertEqual(fail.line, 11)
        self.assertIn("boom mismatch", fail.message)

    def test_failing_test_keeps_subprocess_output(self):
        # The decisive contrast with node's JUnit reporter, which drops both.
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        fail = by_name(res, "test_fails_with_output")
        self.assertIn("config key missing from rendered template", fail.stdout)
        self.assertIn("subproc stdout detail", fail.stdout)
        self.assertIn("subproc stderr detail", fail.stderr)

    def test_mangled_ansi_is_stripped(self):
        # pytest rewrites ESC to the literal text "#x1B", so a \x1b-based strip
        # matches nothing. Ambient FORCE_COLOR is what puts it there.
        raw = read("pytest-ansi-mangled.xml")
        self.assertIn("#x1B", raw)
        res = junit_adapter.parse(fixture("pytest-ansi-mangled.xml"), blank("pytest"))
        text = digest(res, "/tmp/x.json")
        self.assertNotIn("#x1B", text)
        self.assertNotIn("\x1b", text)

    def test_collection_error_blames_user_code_not_the_stdlib(self):
        res = junit_adapter.parse(
            fixture("pytest-collection-error.xml"), blank("pytest", 2)
        )
        self.assertEqual(res.totals["fail"], 1)
        fail = res.failures[0]
        self.assertNotIn("site-packages", fail.file or "")
        self.assertNotIn("/lib/python", fail.file or "")
        self.assertIn("test_bad.py", fail.file)
        self.assertIn("SyntaxError", fail.message)

    def test_markers_split_out_of_pass_and_skip(self):
        res = junit_adapter.parse(
            fixture("pytest-markers.xml"),
            blank("pytest"),
            summary_text=read("pytest-markers-summary.txt"),
        )
        self.assertEqual(res.totals["tests"], 5)
        self.assertEqual(res.totals["xfail"], 1)
        self.assertEqual(res.totals["xpass"], 1)
        self.assertEqual(res.totals["skip"], 0)
        self.assertEqual(res.totals["pass"], 1)
        self.assertEqual(res.totals["fail"], 2)

    def test_markers_default_to_zero_without_a_summary_line(self):
        # XML alone cannot see a non-strict xpass; totals must still add up.
        res = junit_adapter.parse(fixture("pytest-markers.xml"), blank("pytest"))
        self.assertEqual(res.totals["xfail"], 0)
        self.assertEqual(res.totals["xpass"], 0)
        self.assertEqual(res.totals["skip"], 1)
        self.assertEqual(res.totals["pass"], 2)

    def test_strict_xpass_has_a_location_despite_no_traceback(self):
        res = junit_adapter.parse(fixture("pytest-markers.xml"), blank("pytest"))
        fail = by_name(res, "test_xpass_strict")
        self.assertIsNotNone(fail.file)
        self.assertIn("XPASS", fail.message)

    def test_summary_scan_ignores_lines_without_a_duration(self):
        self.assertEqual(junit_adapter.marker_counts("collected 3 passed items"), {})
        self.assertEqual(junit_adapter.marker_counts("no tests ran in 0.01s"), {})
        self.assertEqual(
            junit_adapter.marker_counts("  2 failed, 1 xpassed in 0.10s"),
            {"failed": 2, "xpassed": 1},
        )


class TestJUnitLocationFallbacks(unittest.TestCase):
    """JUnit emitters that are not pytest state the location in attributes
    instead of a traceback. ruff is the case in hand: its @classname drops the
    file extension, and only the enclosing @testsuite name is the real path."""

    def test_ruff_location_comes_from_the_suite_name_and_line_attribute(self):
        res = junit_adapter.parse(fixture("ruff-findings.xml"), blank("ruff"))
        fail = res.failures[0]
        self.assertEqual(fail.file, "/sample/bad.py")  # not @classname "/sample/bad"
        self.assertEqual(fail.line, 1)

    def test_a_real_frame_still_outranks_the_attributes(self):
        # The fallbacks must stay fallbacks: pytest's own @line is 0-based and
        # points at the declaration, so preferring it would move every location.
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        fail = by_name(res, "test_fails_with_output")
        self.assertEqual(fail.file, "test_fail.py")
        self.assertEqual(fail.line, 11)

    def test_a_suite_name_that_is_not_a_path_is_never_used_as_one(self):
        self.assertFalse(junit_adapter.looks_like_path("pytest"))
        self.assertFalse(junit_adapter.looks_like_path(None))
        self.assertTrue(junit_adapter.looks_like_path("/sample/bad.py"))
        self.assertTrue(junit_adapter.looks_like_path("bad.py"))


class TestGradleAndMavenFixturesAreOrdinaryJUnit(unittest.TestCase):
    """Gradle and Maven need no adapter of their own — junit_adapter already
    parses whatever standard JUnit XML they write to disk."""

    def test_gradle_report_parses_as_junit(self):
        res = junit_adapter.parse(fixture("gradle-test-results.xml"), blank("gradle"))
        self.assertEqual(res.totals["tests"], 3)
        self.assertEqual(res.totals["pass"], 2)
        self.assertEqual(res.totals["fail"], 1)
        fail = by_name(res, "testDivideByZero")
        self.assertIn("expected:<1> but was:<0>", fail.message)

    def test_maven_report_parses_as_junit(self):
        res = junit_adapter.parse(fixture("maven-surefire-report.xml"), blank("mvn"))
        self.assertEqual(res.totals["tests"], 2)
        self.assertEqual(res.totals["pass"], 1)
        self.assertEqual(res.totals["fail"], 1)
        fail = by_name(res, "testWeight")
        self.assertIn("expected:<5.0> but was:<4.5>", fail.message)


if __name__ == "__main__":
    unittest.main(verbosity=1)
