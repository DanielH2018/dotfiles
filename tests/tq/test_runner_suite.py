#!/usr/bin/env python3
"""The test-suite runners: report globbing and merging."""

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

import process
from helpers import (
    blank,
    fixture,
    load_cli,
)
from runners import suite as suite_runner


class TestJunitReportMerging(unittest.TestCase):
    """parse_junit_reports() exists because junit_adapter.parse() overwrites
    result.totals and result.duration_ms on every call rather than summing
    them — each call recomputes both from just the <testsuite> elements in
    the one file it was given. Calling it straight on a shared Result across
    Gradle's or Maven's several report files would keep only the last file's
    counts. failures is the exception: parse() appends into whatever list it
    is handed, so it is safe to grow directly."""

    def setUp(self):
        self.cli = load_cli()

    def test_totals_are_summed_across_files_not_overwritten(self):
        result = blank("gradle", exit_code=0)
        paths = [
            fixture("gradle-test-results.xml"),
            fixture("maven-surefire-report.xml"),
        ]
        suite_runner.parse_junit_reports(paths, result)
        self.assertEqual(result.totals["tests"], 5)
        self.assertEqual(result.totals["pass"], 3)
        self.assertEqual(result.totals["fail"], 2)

    def test_failures_from_every_file_are_kept(self):
        result = blank("gradle", exit_code=0)
        paths = [
            fixture("gradle-test-results.xml"),
            fixture("maven-surefire-report.xml"),
        ]
        suite_runner.parse_junit_reports(paths, result)
        self.assertEqual(
            {f.name for f in result.failures}, {"testDivideByZero", "testWeight"}
        )

    def test_an_unreadable_path_is_skipped_not_fatal(self):
        # A compile failure can leave a partial or truncated report behind
        # for one module while another module's report is intact — one bad
        # file must not cost the whole merge.
        result = blank("gradle", exit_code=0)
        paths = ["/no/such/file.xml", fixture("gradle-test-results.xml")]
        suite_runner.parse_junit_reports(paths, result)
        self.assertEqual(result.totals["tests"], 3)
        self.assertEqual(len(result.failures), 1)

    def test_no_paths_leaves_totals_at_zero(self):
        result = blank("gradle", exit_code=0)
        suite_runner.parse_junit_reports([], result)
        self.assertEqual(result.totals["tests"], 0)
        self.assertEqual(result.failures, [])


class TestGradleAndMvnRunners(unittest.TestCase):
    """run_gradle_test/run_mvn_test: run the command untouched, then glob for
    whatever report files it left behind. The command itself is faked out —
    the real risk here is glob-path correctness across a multi-module build,
    not the subprocess call, which every other run_* already exercises."""

    class Proc:
        returncode = 0
        stdout = ""
        stderr = ""

    def setUp(self):
        self.cli = load_cli()
        self.cmds = []

        def fake_run(argv, env):
            self.cmds.append(list(argv))
            return self.Proc(), False

        self.addCleanup(setattr, process, "run", process.run)
        process.run = fake_run

    def test_no_flags_are_injected(self):
        with tempfile.TemporaryDirectory() as workdir:
            suite_runner.run_gradle_test(["gradle", "test"], workdir, workdir)
            self.assertEqual(self.cmds[-1], ["gradle", "test"])
            suite_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
            self.assertEqual(self.cmds[-1], ["mvn", "test"])

    def test_gradle_reports_are_found_across_multiple_modules(self):
        with tempfile.TemporaryDirectory() as workdir:
            for module, src in (
                ("module-a", "gradle-test-results.xml"),
                ("module-b", "maven-surefire-report.xml"),
            ):
                dest = os.path.join(workdir, module, "build", "test-results", "test")
                os.makedirs(dest)
                shutil.copy(fixture(src), os.path.join(dest, f"TEST-{module}.xml"))
            result, _ = suite_runner.run_gradle_test(
                ["gradle", "test"], workdir, workdir
            )
            self.assertEqual(result.totals["tests"], 5)
            self.assertEqual(result.totals["fail"], 2)
            self.assertEqual(len(result.failures), 2)

    def test_mvn_reports_are_found_across_multiple_modules(self):
        with tempfile.TemporaryDirectory() as workdir:
            for module, src in (
                ("module-a", "gradle-test-results.xml"),
                ("module-b", "maven-surefire-report.xml"),
            ):
                dest = os.path.join(workdir, module, "target", "surefire-reports")
                os.makedirs(dest)
                shutil.copy(fixture(src), os.path.join(dest, f"TEST-{module}.xml"))
            result, _ = suite_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
            self.assertEqual(result.totals["tests"], 5)
            self.assertEqual(result.totals["fail"], 2)

    def test_glob_matches_are_sorted_for_deterministic_order(self):
        with tempfile.TemporaryDirectory() as workdir:
            dest = os.path.join(workdir, "build", "test-results", "test")
            os.makedirs(dest)
            shutil.copy(
                fixture("maven-surefire-report.xml"), os.path.join(dest, "TEST-z.xml")
            )
            shutil.copy(
                fixture("gradle-test-results.xml"), os.path.join(dest, "TEST-a.xml")
            )
            result, _ = suite_runner.run_gradle_test(
                ["gradle", "test"], workdir, workdir
            )
            self.assertEqual(
                [f.name for f in result.failures], ["testDivideByZero", "testWeight"]
            )

    def test_no_report_files_leaves_totals_at_zero(self):
        # A compile failure before any test class runs writes no report at
        # all — nothing here to parse, and the empty totals are what let
        # digest.py's NO TESTS RAN carry the verdict, the same as every
        # other test runner's "collected nothing" case.
        with tempfile.TemporaryDirectory() as workdir:
            result, _ = suite_runner.run_gradle_test(
                ["gradle", "test"], workdir, workdir
            )
            self.assertEqual(result.totals["tests"], 0)
            self.assertEqual(result.failures, [])
            result, _ = suite_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
            self.assertEqual(result.totals["tests"], 0)
            self.assertEqual(result.failures, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
