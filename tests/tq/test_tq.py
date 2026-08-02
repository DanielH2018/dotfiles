#!/usr/bin/env python3
"""Unit tests for the tq adapters and digest, against fixtures captured from
real pytest and node --test runs. Run directly: python3 tests/tq/test_tq.py"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import cmdline
import detect as detect_mod
import digest as digest_mod
import process
import scope
from adapters import cargo as cargo_adapter
from adapters import go as go_adapter
from adapters import junit as junit_adapter
from adapters import lint as lint_adapter
from adapters import node as node_adapter
from adapters import rdjson as rdjson_adapter
from adapters import sarif as sarif_adapter
from adapters import survey as survey_adapter
from digest import MAX_DIGEST, digest
from result import Failure, Item, Result, strip_ansi
from runners import git as git_runner
from runners import lint as lint_runner
from runners import survey as survey_runner
from runners import tests as test_runner


def fixture(name):
    return os.path.join(FIXTURES, name)


def read(name):
    with open(fixture(name), encoding="utf-8") as fh:
        return fh.read()


def blank(runner, exit_code=1, cwd="/sample"):
    return Result(runner=runner, cmd=runner, cwd=cwd, exit=exit_code)


def by_name(result, name):
    return next(f for f in result.failures if f.name == name)


def write_ndjson(records):
    with tempfile.NamedTemporaryFile(
        "w", suffix=".ndjson", delete=False, encoding="utf-8"
    ) as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")
        return fh.name


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


def ndjson(records):
    return "\n".join(json.dumps(r) for r in records)


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


class TestDigest(unittest.TestCase):
    def test_passing_run_is_one_line(self):
        res = blank("node", 0)
        res.totals.update(tests=529, skip=4, **{"pass": 525})
        res.duration_ms = 6222
        self.assertEqual(digest(res, "/tmp/x.json"), "PASS 525/529  (4 skipped)  6.2s")

    def test_markers_are_listed_separately_from_skips(self):
        res = blank("pytest", 0)
        res.totals.update(tests=1213, skip=2, xfail=1, xpass=1, **{"pass": 1209})
        res.duration_ms = 297300
        self.assertEqual(
            digest(res, "/tmp/x.json"),
            "PASS 1209/1213  (2 skipped, 1 xfailed, 1 xpassed)  297.3s",
        )

    def test_failure_lines_are_relative_and_carry_the_json_path(self):
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        text = digest(res, "/tmp/tq-4f2a.json")
        self.assertTrue(text.startswith("FAIL 2/4 "))
        self.assertIn("test_fail.py:11", text)
        self.assertIn("json: /tmp/tq-4f2a.json", text)

    def test_an_empty_run_is_never_dressed_up_as_a_pass(self):
        res = blank("node", 0)
        text = digest(res, "/tmp/x.json")
        self.assertTrue(text.startswith("NO TESTS RAN"))
        self.assertNotIn("PASS", text)

    def test_nonzero_exit_with_nothing_parsed_never_reads_as_a_pass(self):
        res = blank("node", 1)
        res.totals.update(tests=3, **{"pass": 3})
        text = digest(res, "/tmp/x.json")
        self.assertTrue(text.startswith("FAIL"))
        self.assertIn("runner exited 1", text)

    def test_failures_beyond_the_cap_are_counted_not_dropped_silently(self):
        res = blank("node")
        res.totals.update(tests=40, fail=40)
        for i in range(40):
            res.failures.append(Failure(name=f"t{i}", file="a.js", line=i + 1))
        text = digest(res, "/tmp/x.json")
        self.assertEqual(res.truncated["failures"], 40 - 10)
        self.assertIn("30 more failures in the json", text)

    def test_long_output_is_capped_and_the_loss_is_reported(self):
        res = blank("node")
        res.totals.update(tests=1, fail=1)
        res.failures.append(
            Failure(name="t", file="a.js", line=1, stdout="x\ny" * 4000)
        )
        text = digest(res, "/tmp/x.json")
        self.assertGreater(res.truncated["stdout_bytes"], 0)
        self.assertIn("bytes (see json)", text)

    def test_serialized_result_matches_the_documented_shape(self):
        res = junit_adapter.parse(fixture("pytest-failures.xml"), blank("pytest"))
        payload = res.to_dict()
        self.assertEqual(
            set(payload),
            {
                "runner",
                "kind",
                "cmd",
                "cwd",
                "exit",
                "timed_out",
                "duration_ms",
                "attempts",
                "totals",
                "failures",
                "items",
                "limited",
                "notes",
                "truncated",
            },
        )
        self.assertEqual(
            set(payload["failures"][0]),
            {
                "file",
                "line",
                "column",
                "end_line",
                "end_column",
                "name",
                "severity",
                "code_url",
                "source",
                "fixable",
                "flaky",
                "message",
                "stdout",
                "stderr",
            },
        )


def load_cli():
    """The CLI is `executable_tq` — no .py suffix, so import it by path."""
    import importlib.util

    path = os.path.join(
        HERE, os.pardir, os.pardir, "home", "dot_local", "bin", "executable_tq"
    )
    spec = importlib.util.spec_from_loader(
        "tq_cli", importlib.machinery.SourceFileLoader("tq_cli", path)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


class TestLintAdapter(unittest.TestCase):
    def test_shellcheck_findings_become_located_failures(self):
        res = blank("shellcheck")
        lint_adapter.parse_shellcheck(read("shellcheck-findings.json"), res)
        self.assertEqual(len(res.failures), 4)
        self.assertEqual(res.failures[0].file, "bad.sh")
        self.assertEqual(res.failures[0].name, "SC2034")

    def test_worst_level_sorts_first_so_the_digest_cap_keeps_errors(self):
        res = blank("shellcheck")
        lint_adapter.parse_shellcheck(read("shellcheck-findings.json"), res)
        ranks = [lint_adapter.LEVEL_RANK[f.severity] for f in res.failures]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(res.failures[-1].name, "SC2086")  # the only info-level one

    def test_a_clean_run_yields_no_findings(self):
        res = blank("shellcheck", exit_code=0)
        lint_adapter.parse_shellcheck(read("shellcheck-clean.json"), res)
        self.assertEqual(res.failures, [])

    def test_output_that_is_not_json_is_left_for_the_raw_fallback(self):
        res = blank("shellcheck")
        lint_adapter.parse_shellcheck("shellcheck: command not found", res)
        self.assertEqual(res.failures, [])

    def test_ruffs_clean_placeholder_is_not_kept_as_a_passing_test(self):
        # ruff writes <testcase name="No errors found"/> when it finds nothing,
        # which the test-shaped reading reports as PASS 1/1 — the same for a
        # directory holding no Python at all.
        res = junit_adapter.parse(fixture("ruff-clean.xml"), blank("ruff", exit_code=0))
        self.assertEqual(res.totals["tests"], 1)
        lint_adapter.as_diagnostics(res)
        self.assertEqual(res.totals["tests"], 0)
        self.assertEqual(res.totals["pass"], 0)

    def test_diagnostic_totals_are_a_count_not_a_pass_rate(self):
        res = junit_adapter.parse(fixture("ruff-findings.xml"), blank("ruff"))
        lint_adapter.as_diagnostics(res)
        self.assertEqual(res.totals["tests"], 4)
        self.assertEqual(res.totals["fail"], 4)
        self.assertEqual(res.totals["pass"], 0)

    def test_mypy_findings_become_located_failures(self):
        res = blank("mypy")
        lint_adapter.parse_mypy(read("mypy-findings.json"), res)
        self.assertEqual(len(res.failures), 2)
        self.assertEqual(res.failures[0].file, "pkg/models.py")
        self.assertEqual(res.failures[0].line, 12)
        self.assertEqual(res.failures[0].name, "return-value")
        self.assertEqual(res.failures[0].severity, "error")

    def test_mypys_summary_line_is_not_json_and_is_skipped(self):
        res = blank("mypy")
        lint_adapter.parse_mypy(read("mypy-findings.json"), res)
        self.assertTrue(all(f.name != "?" for f in res.failures))
        self.assertEqual(len(res.failures), 2)  # the summary line adds no third

    def test_eslint_findings_are_flattened_from_their_per_file_grouping(self):
        res = blank("eslint")
        lint_adapter.parse_eslint(read("eslint-findings.json"), res)
        self.assertEqual(len(res.failures), 3)
        by_rule = {f.name: f for f in res.failures}
        self.assertEqual(by_rule["no-unused-vars"].severity, "error")
        self.assertEqual(by_rule["no-console"].severity, "warning")
        self.assertEqual(by_rule["no-console"].fixable, "unsafe")

    def test_eslint_ruleless_fatal_error_still_gets_a_name(self):
        res = blank("eslint")
        lint_adapter.parse_eslint(read("eslint-findings.json"), res)
        fatal = next(f for f in res.failures if f.file == "/sample/src/broken.js")
        self.assertEqual(fatal.name, "eslint")
        self.assertEqual(fatal.severity, "error")

    def test_tsc_findings_become_located_failures(self):
        res = blank("tsc")
        lint_adapter.parse_tsc(read("tsc-findings.txt"), res)
        self.assertEqual(len(res.failures), 3)
        first = by_name(res, "TS2345")
        self.assertEqual(first.file, "src/app.ts")
        self.assertEqual(first.line, 12)
        self.assertEqual(first.column, 5)
        self.assertEqual(first.severity, "error")

    def test_tsc_related_information_is_folded_into_the_diagnostic_above(self):
        res = blank("tsc")
        lint_adapter.parse_tsc(read("tsc-findings.txt"), res)
        overload = by_name(res, "TS2554")
        self.assertIn("Argument specified here", overload.message)
        self.assertEqual(len(res.failures), 3)  # the continuation adds no third

    def test_tsc_worst_level_sorts_first(self):
        res = blank("tsc")
        lint_adapter.parse_tsc(read("tsc-findings.txt"), res)
        ranks = [lint_adapter.LEVEL_RANK[f.severity] for f in res.failures]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(by_name(res, "TS6133").severity, "warning")

    def test_a_clean_tsc_run_yields_no_findings(self):
        res = blank("tsc", exit_code=0)
        lint_adapter.parse_tsc(read("tsc-clean.txt"), res)
        self.assertEqual(res.failures, [])

    def test_tsc_output_that_matches_nothing_is_left_for_the_raw_fallback(self):
        res = blank("tsc")
        lint_adapter.parse_tsc("tsc: command not found", res)
        self.assertEqual(res.failures, [])

    def test_go_vet_findings_become_located_failures(self):
        res = blank("go")
        lint_adapter.parse_go_vet(read("go-vet-findings.txt"), res)
        self.assertEqual(len(res.failures), 3)
        self.assertTrue(all(f.name == "vet" for f in res.failures))
        self.assertTrue(all(f.severity == "error" for f in res.failures))
        by_file = {f.file: f for f in res.failures}
        self.assertEqual(by_file["util/parse.go"].line, 8)
        self.assertEqual(by_file["util/parse.go"].column, 2)
        self.assertIn("Printf call", by_file["util/parse.go"].message)
        self.assertEqual(by_file["main.go"].line, 12)
        self.assertEqual(by_file["./cmd/tool.go"].line, 20)

    def test_go_vets_package_header_lines_are_not_findings(self):
        res = blank("go")
        lint_adapter.parse_go_vet(read("go-vet-findings.txt"), res)
        self.assertNotIn("# example.com/mymod/util", [f.message for f in res.failures])
        self.assertTrue(all(not f.message.startswith("#") for f in res.failures))

    def test_a_clean_go_vet_run_yields_no_findings(self):
        res = blank("go", exit_code=0)
        lint_adapter.parse_go_vet(read("go-vet-clean.txt"), res)
        self.assertEqual(res.failures, [])


class TestLintDigest(unittest.TestCase):
    def lint(self, exit_code=0, failures=(), notes=(), ms=100):
        res = Result(
            runner="ruff", kind="lint", cmd="ruff check", cwd="/sample", exit=exit_code
        )
        res.failures.extend(failures)
        res.notes.extend(notes)
        res.duration_ms = ms
        return lint_adapter.as_diagnostics(res)

    def test_a_clean_lint_run_is_one_line(self):
        self.assertEqual(digest(self.lint(), "/tmp/x.json"), "CLEAN  0.1s")

    def test_a_linter_that_broke_is_never_reported_as_clean(self):
        text = digest(self.lint(exit_code=2), "/tmp/x.json")
        self.assertTrue(text.startswith("NO FINDINGS PARSED"))
        self.assertNotIn("CLEAN", text)

    def test_a_clean_verdict_over_nothing_carries_the_warning(self):
        text = digest(
            self.lint(notes=["warning: No Python files found under the given path(s)"]),
            "/tmp/x.json",
        )
        self.assertIn("note: warning: No Python files found", text)

    def test_findings_are_counted_over_files(self):
        fails = [
            Failure(name="F401", file="/sample/a.py", line=1, message="unused"),
            Failure(name="F821", file="/sample/b.py", line=2, message="undefined"),
        ]
        text = digest(self.lint(exit_code=1, failures=fails), "/tmp/x.json")
        self.assertTrue(text.startswith("FAIL 2 findings in 2 files"))
        self.assertIn("a.py:1  F401", text)

    def test_one_of_each_reads_singular(self):
        fails = [Failure(name="F401", file="/sample/a.py", line=1, message="unused")]
        text = digest(self.lint(exit_code=1, failures=fails), "/tmp/x.json")
        self.assertTrue(text.startswith("FAIL 1 finding in 1 file"))


class TestDetection(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_launchers_and_python_m_are_seen_through(self):
        self.assertEqual(
            detect_mod.tool_name(["uv", "run", "python", "-m", "pytest"]), "pytest"
        )
        self.assertEqual(detect_mod.tool_name(["uv", "run", "ruff", "check"]), "ruff")
        self.assertEqual(detect_mod.tool_name(["/usr/bin/node", "--test"]), "node")
        self.assertEqual(detect_mod.tool_name(["env", "FOO=1", "pytest"]), "pytest")

    def test_a_command_that_merely_names_a_runner_is_not_one(self):
        # Scanning every token for the runner's name turns `grep pytest notes`
        # into a test run, and injects reporter flags into the grep. Since greps
        # became a survey the answer is no longer None, but it is still the
        # program that was actually run and never the one it was looking for.
        self.assertEqual(self.cli.detect(["grep", "pytest", "notes.txt"]), "grep")
        self.assertEqual(self.cli.detect(["grep", "shellcheck", "notes.txt"]), "grep")
        self.assertIsNone(self.cli.detect(["cat", "pytest", "notes.txt"]))

    def test_ruff_format_is_not_a_diagnostics_run(self):
        self.assertIsNone(self.cli.detect(["ruff", "format", "--check", "."]))
        self.assertEqual(self.cli.detect(["ruff", "check", "."]), "ruff")

    def test_each_known_runner_is_claimed(self):
        self.assertEqual(self.cli.detect(["node", "--test", "x.js"]), "node")
        self.assertEqual(self.cli.detect(["shellcheck", "x.sh"]), "shellcheck")
        self.assertEqual(self.cli.detect(["prek", "run", "--all-files"]), "prek")
        self.assertIsNone(self.cli.detect(["node", "x.js"]))  # no --test

    def test_cargo_subcommands_are_routed_and_everything_else_passes_through(self):
        self.assertEqual(self.cli.detect(["cargo", "clippy"]), "cargo-clippy")
        self.assertEqual(self.cli.detect(["cargo", "test"]), "cargo-test")
        # build, run, publish and anything else cargo grows later: never
        # claimed, the same principle as git's "everything but log/diff
        # passes through" — a wrapper that captures stdout must never decide
        # a subcommand was safe to reinterpret.
        self.assertIsNone(self.cli.detect(["cargo", "build"]))
        self.assertIsNone(self.cli.detect(["cargo", "run"]))
        self.assertIsNone(self.cli.detect(["cargo"]))

    def test_cargo_global_options_are_skipped_to_find_the_verb(self):
        self.assertEqual(
            detect_mod.cargo_subcommand(
                ["cargo", "--manifest-path", "x/Cargo.toml", "test"]
            ),
            "test",
        )
        self.assertEqual(
            detect_mod.cargo_subcommand(["cargo", "-v", "clippy"]), "clippy"
        )

    def test_drop_flag_removes_either_spelling(self):
        self.assertEqual(
            cmdline.drop_flag(
                ["ruff", "check", "--output-format=json", "x"], ("--output-format",)
            ),
            ["ruff", "check", "x"],
        )
        self.assertEqual(
            cmdline.drop_flag(["shellcheck", "-f", "json", "x"], ("-f",)),
            ["shellcheck", "x"],
        )

    def test_go_test_and_go_vet_are_claimed_by_their_subcommand(self):
        self.assertEqual(self.cli.detect(["go", "test", "./..."]), "go-test")
        self.assertEqual(self.cli.detect(["go", "vet", "./..."]), "go-vet")

    def test_other_go_subcommands_pass_through_untouched(self):
        for argv in (
            ["go", "build", "./..."],
            ["go", "run", "main.go"],
            ["go", "get", "x"],
            ["go", "mod", "tidy"],
            ["go"],
        ):
            self.assertIsNone(self.cli.detect(argv), argv)

    def test_gos_own_flag_ahead_of_the_verb_does_not_hide_it(self):
        self.assertEqual(detect_mod.go_subcommand(["go", "-C", "sub", "test"]), "test")
        self.assertEqual(self.cli.detect(["go", "-C", "sub", "vet", "./..."]), "go-vet")

    def test_gradle_test_is_claimed_in_either_spelling(self):
        self.assertEqual(self.cli.detect(["gradle", "test"]), "gradle-test")
        self.assertEqual(self.cli.detect(["./gradlew", "test"]), "gradle-test")
        self.assertEqual(
            self.cli.detect(["gradle", "test", "--tests", "FooTest"]), "gradle-test"
        )

    def test_gradle_build_and_check_pass_through_untouched(self):
        # gradle's default lifecycle also runs tests under `build`/`check`,
        # but claiming that requires understanding the lifecycle binding —
        # out of scope. Only an explicit `test` task is claimed.
        self.assertIsNone(self.cli.detect(["gradle", "build"]))
        self.assertIsNone(self.cli.detect(["gradle", "check"]))
        self.assertIsNone(self.cli.detect(["gradle"]))

    def test_gradle_task_token_must_be_exact_not_a_substring(self):
        # "testCompile" merely contains "test" — the same care FIND_UNSAFE
        # and the grep letter sets take elsewhere against a substring match.
        self.assertIsNone(self.cli.detect(["gradle", "testCompile"]))

    def test_mvn_test_is_claimed(self):
        self.assertEqual(self.cli.detect(["mvn", "test"]), "mvn-test")
        self.assertEqual(self.cli.detect(["mvn", "clean", "test"]), "mvn-test")
        self.assertEqual(self.cli.detect(["mvn", "-pl", "module", "test"]), "mvn-test")

    def test_mvn_install_and_verify_pass_through_untouched(self):
        # `mvn install`/`mvn verify` also run tests as part of Maven's default
        # lifecycle, but same principle as gradle build/check: out of scope.
        self.assertIsNone(self.cli.detect(["mvn", "install"]))
        self.assertIsNone(self.cli.detect(["mvn", "verify"]))
        self.assertIsNone(self.cli.detect(["mvn"]))


class TestTextHelpers(unittest.TestCase):
    def test_strip_ansi_handles_both_real_and_xml_escaped_forms(self):
        self.assertEqual(strip_ansi("\x1b[32m+ actual\x1b[39m"), "+ actual")
        self.assertEqual(strip_ansi("#x1B[1m#x1B[31mtest.py#x1B[0m"), "test.py")

    def test_strip_ansi_keeps_diff_markers(self):
        # node marks actual-vs-expected with colour only when FORCE_COLOR is
        # set; with it unset the +/- prefixes are real text and must survive.
        self.assertEqual(strip_ansi("\x1b[32m+ '/tmp/x'\x1b[39m"), "+ '/tmp/x'")


class TestDigestBudget(unittest.TestCase):
    def noisy(self, count):
        res = blank("node")
        res.totals.update(tests=count, fail=count)
        for i in range(count):
            res.failures.append(
                Failure(
                    name=f"t{i}",
                    file="a.js",
                    line=i + 1,
                    stdout="o" * 4000,
                    stderr="e" * 4000,
                )
            )
        return res

    def test_the_whole_digest_stays_under_its_ceiling(self):
        # Per-failure caps alone allow ten of these, which is ~40KB — over the
        # cap applied to the tool result this lands in.
        text = digest(self.noisy(10), "/tmp/x.json")
        self.assertLessEqual(len(text.encode("utf-8")), MAX_DIGEST + 100)

    def test_the_json_path_precedes_the_failure_detail(self):
        text = digest(self.noisy(10), "/tmp/tq-4f2a.json")
        lines = text.splitlines()
        self.assertEqual(lines[1], "json: /tmp/tq-4f2a.json")

    def test_budget_dropped_failures_are_counted_not_lost(self):
        res = self.noisy(10)
        text = digest(res, "/tmp/x.json")
        self.assertGreater(res.truncated["failures"], 0)
        self.assertIn(f"{res.truncated['failures']} more failures in the json", text)

    def test_one_oversized_failure_is_still_shown_whole(self):
        # A digest that names a failure without showing any of it is barely
        # better than no digest, so the first block ignores the ceiling.
        res = self.noisy(1)
        text = digest(res, "/tmp/x.json")
        self.assertEqual(res.truncated["failures"], 0)
        self.assertIn("stdout", text)

    def test_truncated_stdout_bytes_only_counts_shown_failures(self):
        # A failure dropped for blowing the digest budget still gets its block
        # built (to measure whether it fits), and that block's own cap-dropped
        # bytes must not be folded into a total meant to describe what the
        # *shown* blocks lost.
        res = self.noisy(10)
        digest(res, "/tmp/x.json")
        shown = 10 - res.truncated["failures"]
        self.assertGreater(res.truncated["failures"], 0)  # else nothing to prove
        only_shown = self.noisy(shown)
        digest(only_shown, "/tmp/x.json")
        self.assertEqual(
            res.truncated["stdout_bytes"], only_shown.truncated["stdout_bytes"]
        )

    def test_an_unbounded_message_is_capped(self):
        res = blank("node")
        res.totals.update(tests=1, fail=1)
        res.failures.append(Failure(name="t", file="a.js", line=1, message="m" * 9000))
        text = digest(res, "/tmp/x.json")
        self.assertIn("bytes (see json)", text)
        self.assertLess(len(text.encode("utf-8")), 9000)


class TestTimeoutDigest(unittest.TestCase):
    def test_a_timed_out_run_is_never_a_verdict(self):
        res = blank("node", 124)
        res.timed_out = True
        res.duration_ms = 600000
        res.totals.update(tests=412, **{"pass": 412})
        text = digest(res, "/tmp/x.json")
        self.assertTrue(text.startswith("TIMED OUT after 600s  (412 tests completed)"))
        self.assertNotIn("PASS", text)

    def test_a_timed_out_run_that_collected_nothing_says_so(self):
        res = blank("node", 124)
        res.timed_out = True
        res.duration_ms = 2000
        text = digest(res, "/tmp/x.json")
        self.assertTrue(text.startswith("TIMED OUT after 2s"))
        # The empty-run wording would imply the runner finished and found none.
        self.assertNotIn("NO TESTS RAN", text)

    def test_a_timed_out_linter_is_not_reported_clean(self):
        res = blank("ruff", 124)
        res.kind = "lint"
        res.timed_out = True
        res.duration_ms = 5000
        text = digest(res, "/tmp/x.json")
        self.assertTrue(text.startswith("TIMED OUT after 5s"))
        self.assertNotIn("CLEAN", text)


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


class TestScope(unittest.TestCase):
    """Against a real repo, because every bug this filter can have lives in
    what git actually prints rather than in the filtering itself."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="tq-scope-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        self.git("init", "-q", ".")
        self.git("config", "user.email", "t@t.co")
        self.git("config", "user.name", "t")
        self.write("a.py", "one\ntwo\nthree\nfour\n")
        self.write("b.py", "one\ntwo\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")

    def git(self, *args, **env):
        subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=True,
            capture_output=True,
            env={**os.environ, **env},
        )

    def write(self, name, text):
        with open(os.path.join(self.repo, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def fail_at(self, name, line):
        return Failure(name="F401", file=os.path.join(self.repo, name), line=line)

    def lint_result(self, *failures):
        res = Result(runner="ruff", kind="lint", cmd="ruff", cwd=self.repo, exit=1)
        res.failures.extend(failures)
        return res

    def test_only_changed_lines_survive_added_mode(self):
        self.write("a.py", "one\ntwo\nthree\nCHANGED\n")
        res = self.lint_result(self.fail_at("a.py", 4), self.fail_at("a.py", 1))
        dropped = scope.apply_scope(res, "added", self.repo)
        self.assertEqual(dropped, 1)
        self.assertEqual([f.line for f in res.failures], [4])

    def test_file_mode_keeps_findings_outside_the_hunk(self):
        # An unused import at line 1 is a real finding in a file you touched;
        # `added` alone would drop every one of them.
        self.write("a.py", "one\ntwo\nthree\nCHANGED\n")
        res = self.lint_result(self.fail_at("a.py", 1), self.fail_at("b.py", 1))
        dropped = scope.apply_scope(res, "file", self.repo)
        self.assertEqual(dropped, 1)
        self.assertEqual([os.path.basename(f.file) for f in res.failures], ["a.py"])

    def test_mnemonic_prefixes_do_not_scope_everything_away(self):
        # diff.mnemonicPrefix renames the diff header's a/ and b/ to c/ and w/.
        # Stripping a hardcoded "b/" leaves a path matching nothing, which reads
        # as a completely clean diff — the failure this guards is silent.
        self.git("config", "diff.mnemonicPrefix", "true")
        self.write("a.py", "one\ntwo\nthree\nCHANGED\n")
        changed = scope.touched("HEAD", self.repo)
        self.assertEqual(
            [os.path.basename(p) for p in changed], ["a.py"], f"got {changed}"
        )

    def test_a_finding_that_cannot_be_placed_is_kept(self):
        res = self.lint_result(Failure(name="E902", file=None, line=None))
        self.assertEqual(scope.apply_scope(res, "added", self.repo), 0)
        self.assertEqual(len(res.failures), 1)

    def test_test_failures_are_never_scoped(self):
        # A test breaking in a file the diff never touched is the most valuable
        # thing a run reports; "you did not edit it" must not hide it.
        res = Result(runner="node", cmd="node", cwd=self.repo, exit=1)
        res.failures.append(self.fail_at("b.py", 1))
        self.assertEqual(scope.apply_scope(res, "added", self.repo), 0)
        self.assertEqual(len(res.failures), 1)

    def test_outside_a_repo_everything_is_reported(self):
        plain = tempfile.mkdtemp(prefix="tq-norepo-")
        self.addCleanup(shutil.rmtree, plain, True)
        res = self.lint_result(self.fail_at("a.py", 1))
        self.assertIsNone(scope.touched("HEAD", plain))
        self.assertEqual(scope.apply_scope(res, "added", plain), 0)
        self.assertEqual(len(res.failures), 1)

    def test_added_content_that_looks_like_a_header_is_content(self):
        # A line whose own text starts `++ ` arrives in the diff body as `+++ `.
        # Read as a header it invents a path from the file's contents, and the
        # hunks that follow are filed under it — so the real findings in a.py
        # scope away and findings in a file that does not exist are kept.
        self.write("a.py", "one\n++ b/evil.py\nthree\nfour\n")
        changed = scope.touched("HEAD", self.repo)
        self.assertEqual(sorted(os.path.basename(p) for p in changed), ["a.py"])
        self.assertIn(2, changed[os.path.realpath(os.path.join(self.repo, "a.py"))])

    def test_a_file_git_has_never_seen_is_in_scope(self):
        # The newest code in the tree is the most likely to be the agent's, and
        # it appears in no diff against HEAD at all.
        self.write("new.py", "one\ntwo\n")
        res = self.lint_result(self.fail_at("new.py", 2))
        self.assertEqual(scope.apply_scope(res, "added", self.repo), 0)
        self.assertEqual(len(res.failures), 1)
        res = self.lint_result(self.fail_at("new.py", 2))
        self.assertEqual(scope.apply_scope(res, "file", self.repo), 0)
        self.assertEqual(len(res.failures), 1)

    def test_an_ignored_file_is_still_out_of_scope(self):
        # --exclude-standard: a build artifact is untracked too, and sweeping
        # every untracked path in would put node_modules back in the digest.
        self.write(".gitignore", "junk.py\n")
        self.write("junk.py", "one\n")
        res = self.lint_result(self.fail_at("junk.py", 1))
        self.assertEqual(scope.apply_scope(res, "file", self.repo), 1)
        self.assertEqual(res.failures, [])


class TestScopeHeadline(unittest.TestCase):
    def scoped(self, found, aside, exit_code=1):
        res = Result(runner="ruff", kind="lint", cmd="ruff", cwd="/s", exit=exit_code)
        res.failures.extend(
            Failure(name="F401", file="a.py", line=i) for i in range(found)
        )
        res.truncated["out_of_scope"] = aside
        return digest(res, "/tmp/x.json")

    def test_a_filtered_clean_run_is_not_called_clean(self):
        text = self.scoped(found=0, aside=12)
        self.assertTrue(text.startswith("CLEAN in your diff  (12 outside it)"))

    def test_a_filtered_clean_run_is_not_called_broken(self):
        # The linter exits non-zero because findings exist; reporting that as
        # NO FINDINGS PARSED would call a working tool a broken one.
        self.assertNotIn("NO FINDINGS PARSED", self.scoped(found=0, aside=12))
        self.assertNotIn("no reported failures", self.scoped(found=0, aside=12))

    def test_withheld_findings_are_counted_in_the_headline(self):
        self.assertIn("(9 outside your diff)", self.scoped(found=2, aside=9))

    def test_an_unscoped_run_says_nothing_about_scope(self):
        self.assertNotIn("diff", self.scoped(found=2, aside=0))
        self.assertEqual(
            self.scoped(found=0, aside=0, exit_code=0).split("  ")[0], "CLEAN"
        )


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


class TestRuffJSON(unittest.TestCase):
    def setUp(self):
        self.res = lint_adapter.parse_ruff(read("ruff-json.json"), blank("ruff"))
        self.res.kind = "lint"

    def test_everything_junit_could_not_carry_survives(self):
        # The whole point of leaving JUnit behind: it has nowhere to put a
        # column, a severity, a rule url or a fix.
        fail = by_name(self.res, "F401")
        self.assertEqual(fail.line, 1)
        self.assertEqual(fail.column, 8)
        self.assertEqual(fail.end_line, 1)
        self.assertEqual(fail.source, "ruff")
        self.assertIn("ruff/rules/unused-import", fail.code_url)

    def test_fix_applicability_is_kept_apart(self):
        # An unsafe fix changes behaviour, so "apply them all" is only ever
        # right for the safe half.
        self.assertEqual(by_name(self.res, "F401").fixable, "safe")
        self.assertEqual(by_name(self.res, "F841").fixable, "unsafe")

    def test_the_rule_code_needs_no_unmangling(self):
        # ruff's JUnit named each case org.ruff.F401, so the code had to be dug
        # back out of a classname. Nothing to strip here.
        for fail in self.res.failures:
            self.assertNotIn("org.ruff", fail.name)
            self.assertRegex(fail.name, r"^F\d+$")

    def test_the_digest_reports_what_can_be_fixed_safely(self):
        text = digest(self.res, "/tmp/x.json")
        self.assertIn("2 auto-fixable (1 safe)", text)

    def test_locations_reach_the_digest_with_their_column(self):
        self.assertIn(":1:8  F401", digest(self.res, "/tmp/x.json"))

    def test_output_that_is_not_json_leaves_the_result_alone(self):
        res = lint_adapter.parse_ruff("ruff: command exploded", blank("ruff"))
        self.assertEqual(res.failures, [])


class TestShellcheckFields(unittest.TestCase):
    def setUp(self):
        self.res = lint_adapter.parse_shellcheck(
            read("shellcheck-json1.json"), blank("shellcheck")
        )

    def test_the_json1_fields_tq_used_to_drop_are_kept(self):
        fail = self.res.failures[0]
        self.assertIsNotNone(fail.column)
        self.assertIsNotNone(fail.end_column)
        self.assertEqual(fail.source, "shellcheck")

    def test_the_wiki_url_is_derived_from_the_code(self):
        fail = self.res.failures[0]
        self.assertEqual(fail.code_url, f"https://www.shellcheck.net/wiki/{fail.name}")

    def test_severity_is_a_field_not_a_prefix_on_the_message(self):
        # It used to be glued to the front of the message, which put it beyond
        # the reach of sorting and of the digest's own formatting.
        for fail in self.res.failures:
            self.assertNotIn(f"{fail.severity}:", fail.message)
            self.assertIn(fail.severity, ("error", "warning", "info", "style"))


class TestCargoClippyAdapter(unittest.TestCase):
    def setUp(self):
        self.res = lint_adapter.parse_cargo_clippy(
            read("cargo-clippy-findings.json"), blank("cargo clippy")
        )

    def test_compiler_artifact_and_build_finished_lines_are_skipped(self):
        # Only "compiler-message" carries a diagnostic; the fixture mixes in
        # one of each of the others to prove they never become a finding.
        self.assertEqual(len(self.res.failures), 3)

    def test_worst_level_sorts_first_so_the_digest_cap_keeps_errors(self):
        ranks = [lint_adapter.LEVEL_RANK[f.severity] for f in self.res.failures]
        self.assertEqual(ranks, sorted(ranks))
        self.assertEqual(self.res.failures[0].name, "clippy::never_loop")

    def test_the_primary_span_is_used_not_the_macro_expansion_site(self):
        fail = by_name(self.res, "clippy::never_loop")
        self.assertEqual(fail.file, "src/lib.rs")
        self.assertEqual(fail.line, 10)
        self.assertEqual(fail.end_line, 12)

    def test_a_plain_rustc_lint_with_no_clippy_code_falls_back_to_a_name(self):
        fail = by_name(self.res, "clippy")
        self.assertEqual(fail.message, "unreachable code")
        self.assertEqual(fail.severity, "warning")

    def test_nothing_is_ever_claimed_as_safe_to_apply(self):
        # A span carries a suggested_replacement, but tq does not attempt to
        # judge its safety from the raw JSON, the same restraint ruff and
        # mypy show.
        self.assertTrue(all(f.fixable is None for f in self.res.failures))

    def test_a_clean_build_yields_no_findings(self):
        res = lint_adapter.parse_cargo_clippy(
            read("cargo-clippy-clean.json"), blank("cargo clippy", exit_code=0)
        )
        self.assertEqual(res.failures, [])

    def test_output_that_is_not_json_is_left_for_the_raw_fallback(self):
        res = lint_adapter.parse_cargo_clippy(
            "cargo: command not found", blank("cargo")
        )
        self.assertEqual(res.failures, [])


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
        test_runner.parse_junit_reports(paths, result)
        self.assertEqual(result.totals["tests"], 5)
        self.assertEqual(result.totals["pass"], 3)
        self.assertEqual(result.totals["fail"], 2)

    def test_failures_from_every_file_are_kept(self):
        result = blank("gradle", exit_code=0)
        paths = [
            fixture("gradle-test-results.xml"),
            fixture("maven-surefire-report.xml"),
        ]
        test_runner.parse_junit_reports(paths, result)
        self.assertEqual(
            {f.name for f in result.failures}, {"testDivideByZero", "testWeight"}
        )

    def test_an_unreadable_path_is_skipped_not_fatal(self):
        # A compile failure can leave a partial or truncated report behind
        # for one module while another module's report is intact — one bad
        # file must not cost the whole merge.
        result = blank("gradle", exit_code=0)
        paths = ["/no/such/file.xml", fixture("gradle-test-results.xml")]
        test_runner.parse_junit_reports(paths, result)
        self.assertEqual(result.totals["tests"], 3)
        self.assertEqual(len(result.failures), 1)

    def test_no_paths_leaves_totals_at_zero(self):
        result = blank("gradle", exit_code=0)
        test_runner.parse_junit_reports([], result)
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
            test_runner.run_gradle_test(["gradle", "test"], workdir, workdir)
            self.assertEqual(self.cmds[-1], ["gradle", "test"])
            test_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
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
            result, _ = test_runner.run_gradle_test(
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
            result, _ = test_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
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
            result, _ = test_runner.run_gradle_test(
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
            result, _ = test_runner.run_gradle_test(
                ["gradle", "test"], workdir, workdir
            )
            self.assertEqual(result.totals["tests"], 0)
            self.assertEqual(result.failures, [])
            result, _ = test_runner.run_mvn_test(["mvn", "test"], workdir, workdir)
            self.assertEqual(result.totals["tests"], 0)
            self.assertEqual(result.failures, [])


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


def survey_blank(kind, runner="find", exit_code=0):
    return Result(runner=runner, kind=kind, cmd=runner, cwd="/sample", exit=exit_code)


class TestSurveyDetection(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_only_the_read_only_git_subcommands_are_claimed(self):
        self.assertEqual(self.cli.detect(["git", "log", "--oneline"]), "git-log")
        self.assertEqual(self.cli.detect(["git", "diff", "HEAD"]), "git-diff")
        self.assertEqual(self.cli.detect(["git", "-C", "/repo", "log"]), "git-log")
        # A wrapper that captures stdout must never be the thing that decides a
        # mutation was safe, so everything else runs untouched.
        self.assertIsNone(self.cli.detect(["git", "commit", "-m", "x"]))
        self.assertIsNone(self.cli.detect(["git", "push"]))
        self.assertIsNone(self.cli.detect(["git", "-C", "/repo", "reset", "--hard"]))
        self.assertIsNone(self.cli.detect(["git"]))

    def test_a_find_that_runs_or_reformats_is_not_a_sweep(self):
        self.assertEqual(self.cli.detect(["find", ".", "-name", "*.py"]), "find")
        for action in (["-delete"], ["-exec", "rm", "{}", ";"], ["-printf", "%p"]):
            self.assertIsNone(self.cli.detect(["find", ".", *action]), action)

    def test_grep_flags_that_change_the_answer_shape_pass_through(self):
        self.assertEqual(self.cli.detect(["grep", "-rn", "x", "."]), "grep")
        self.assertEqual(self.cli.detect(["rg", "x", "."]), "rg")
        # `rg --files` takes no pattern at all; --json would reject it.
        self.assertEqual(self.cli.detect(["rg", "--files"]), "rg-files")
        for flag in ("-c", "-l", "-L", "-q", "-o"):
            self.assertIsNone(self.cli.detect(["grep", flag, "x", "."]), flag)

    def test_ls_is_a_sweep_only_when_recursive_and_not_long(self):
        self.assertEqual(self.cli.detect(["ls", "-R", "src"]), "ls")
        self.assertEqual(self.cli.detect(["ls", "-aR", "src"]), "ls")
        self.assertIsNone(self.cli.detect(["ls", "src"]))
        # -lR bundles a long listing: those lines carry permissions, not paths.
        self.assertIsNone(self.cli.detect(["ls", "-lR", "src"]))

    def test_a_diff_asked_for_its_status_is_left_alone(self):
        # --exit-code makes the status the answer. The survey headline reads a
        # non-zero status as an incomplete enumeration, so the two cannot share
        # a command without one of them lying.
        self.assertIsNone(self.cli.detect(["git", "diff", "--exit-code"]))
        self.assertIsNone(self.cli.detect(["git", "diff", "--quiet"]))


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


class TestSurveyParsers(unittest.TestCase):
    def test_paths_split_on_nul_when_the_command_could_be_asked_for_it(self):
        res = survey_adapter.parse_paths("a/b.py\0a/c.py\0", survey_blank("paths"))
        self.assertEqual([i.path for i in res.items], ["a/b.py", "a/c.py"])

    def test_a_newline_in_a_filename_only_costs_the_fallback_form(self):
        nul = survey_adapter.parse_paths("we\nird.py\0ok.py\0", survey_blank("paths"))
        self.assertEqual([i.path for i in nul.items], ["we\nird.py", "ok.py"])

    def test_ls_entries_are_joined_onto_the_header_they_appeared_under(self):
        text = "src:\napp.py\nutil.py\n\nsrc/web:\nviews.py\n"
        res = survey_adapter.parse_ls_r(text, survey_blank("paths"))
        # A bare name is not a path: grouping on one would put every views.py
        # in the tree into a single bucket.
        self.assertEqual(
            [i.path for i in res.items],
            ["src/app.py", "src/util.py", "src/web/views.py"],
        )

    def test_a_line_matched_twice_is_two_matches_and_one_row(self):
        event = json.dumps(
            {
                "type": "match",
                "data": {
                    "path": {"text": "a.py"},
                    "line_number": 3,
                    "lines": {"text": "x = x + 1\n"},
                    "submatches": [{"start": 0}, {"start": 4}],
                },
            }
        )
        res = survey_adapter.parse_rg_json(event, survey_blank("matches", "rg"))
        self.assertEqual(len(res.items), 1)
        self.assertEqual(res.items[0].matches, 2)
        self.assertEqual(res.items[0].line, 3)

    def test_a_form_feed_in_a_matched_line_is_not_a_second_match(self):
        # str.splitlines() breaks on form feed, the record separators and NEL.
        # A source file with an Emacs page break in it would have one hit
        # counted as two, and the count is the whole answer here.
        res = survey_adapter.parse_grep(
            "a.py\x0012:before\x0cafter\n", survey_blank("matches", "grep")
        )
        self.assertEqual(len(res.items), 1)
        self.assertEqual(res.items[0].path, "a.py")
        self.assertEqual(res.items[0].line, 12)

    def test_a_path_with_a_colon_survives_the_nul_form(self):
        res = survey_adapter.parse_grep(
            "od:d.py\x009:hit\n", survey_blank("matches", "grep")
        )
        self.assertEqual(res.items[0].path, "od:d.py")
        self.assertEqual(res.items[0].line, 9)

    def test_numstat_reads_renames_and_binaries(self):
        raw = "10\t2\tsrc/a.py\x005\t0\t\x00old/b.py\x00new/b.py\x00-\t-\tlogo.png\x00"
        res = survey_adapter.parse_numstat(raw, survey_blank("diff", "git diff"))
        self.assertEqual(
            [i.path for i in res.items], ["src/a.py", "new/b.py", "logo.png"]
        )
        self.assertEqual(res.items[1].old_path, "old/b.py")
        self.assertEqual(res.items[1].status, "R")
        # git writes "-" for a binary rather than 0, which is the difference
        # between "no lines changed" and "lines are not the unit here".
        self.assertIsNone(res.items[2].added)

    def test_commits_survive_the_record_separator_they_are_marked_with(self):
        raw = (
            "\x1eabc123\x1fDaniel\x1f2026-07-25T10:00:00-05:00\x1fFix the thing\n"
            "\x1edef456\x1fSam\x1f2026-07-24T10:00:00-05:00\x1fAdd a thing\n"
        )
        res = survey_adapter.parse_commits(raw, survey_blank("commits", "git log"))
        self.assertEqual([i.sha for i in res.items], ["abc123", "def456"])
        self.assertEqual(res.items[0].text, "Fix the thing")
        self.assertEqual(res.items[1].author, "Sam")

    def test_numstat_rows_are_attributed_to_the_commit_above_them(self):
        raw = (
            "\x1eabc\x1fDaniel\x1f2026-07-25T10:00:00-05:00\x1fOne\n"
            "3\t1\ta.py\n7\t0\tb.py\n"
            "\x1edef\x1fDaniel\x1f2026-07-24T10:00:00-05:00\x1fTwo\n"
            "1\t1\tc.py\n"
        )
        res = survey_adapter.parse_commits(raw, survey_blank("commits", "git log"))
        self.assertEqual((res.items[0].added, res.items[0].deleted), (10, 1))
        self.assertEqual(res.items[0].matches, 2)
        self.assertEqual(res.items[1].matches, 1)


class TestSurveyDigest(unittest.TestCase):
    def paths(self, names, exit_code=0):
        res = survey_blank("paths", exit_code=exit_code)
        res.items = [Item(path=name) for name in names]
        return res

    def test_a_sweep_small_enough_to_print_is_printed_whole(self):
        # A histogram of nine paths is strictly worse than the nine paths, and
        # tq only earns its place when it says less than the command would have.
        res = self.paths([f"src/f{n}.py" for n in range(9)])
        text = digest(res, "/tmp/x.json")
        for n in range(9):
            self.assertIn(f"src/f{n}.py", text)
        self.assertNotIn("sample (", text)
        # Nothing was withheld, so there is nothing to go and look up.
        self.assertNotIn("/tmp/x.json", text)

    def test_a_truncated_histogram_accounts_for_what_it_dropped(self):
        names = [f"d{n:03d}/f{i}.py" for n in range(40) for i in range(5)]
        text = digest(self.paths(names), "/tmp/x.json")
        self.assertIn("more directories", text)
        shown = [ln for ln in text.splitlines() if re.match(r"^  d\d{3}\s", ln)]
        listed = sum(int(ln.split()[-1].replace(",", "")) for ln in shown)
        remainder = int(
            re.search(r"\+([\d,]+) more directories", text)[1].replace(",", "")
        )
        dropped = int(
            re.search(r"more directories, ([\d,]+) paths", text)[1].replace(",", "")
        )
        # The buckets shown plus the ones counted off the bottom must be every
        # path: a top-N list that does not add up reads as the whole shape.
        self.assertEqual(listed + dropped, 200)
        self.assertEqual(len(shown) + remainder, 40)

    def test_the_sample_crosses_the_list_rather_than_taking_its_head(self):
        # find walks depth-first and git log runs newest-first, so the first
        # eight rows of either come from one corner of the answer.
        names = [f"d{n:03d}/f.py" for n in range(200)]
        text = digest(self.paths(names), "/tmp/x.json")
        block = text.split("evenly spaced):")[1]
        # Both ends and nothing bunched at the front. Pinning the middle rows to
        # particular indices only pins the arithmetic that produced them.
        self.assertIn("d000/", block)
        self.assertIn("d199/", block)
        self.assertNotIn("d001/", block)

    def test_a_grouping_key_that_says_nothing_is_not_drawn(self):
        # Every path under one directory makes a one-bucket histogram, which
        # restates the count in a second place and distinguishes nothing.
        text = digest(self.paths([f"src/f{n}.py" for n in range(60)]), "/tmp/x.json")
        self.assertNotIn("  src   ", text)
        self.assertIn("sample (", text)

    def test_a_failed_sweep_never_reports_a_total(self):
        # find keeps going past an unreadable directory and exits non-zero. The
        # count is of what it could reach, which is not the count of what is
        # there — the same rule as TIMED OUT.
        text = digest(self.paths([f"d{n}/f.py" for n in range(60)], exit_code=1), "/x")
        self.assertIn("enumeration incomplete", text)

    def test_nothing_found_and_nothing_readable_do_not_read_alike(self):
        self.assertIn("no paths", digest(self.paths([]), "/x"))
        self.assertIn("NO PATHS PARSED", digest(self.paths([], exit_code=1), "/x"))

    def test_a_capped_count_is_reported_as_a_floor(self):
        res = survey_blank("commits", "git log")
        res.items = [Item(sha=f"{n:07d}", date="2026-07-25") for n in range(50)]
        res.limited = "-n 50"
        self.assertIn("there may be more", digest(res, "/x"))

    def test_no_match_is_an_answer_and_a_broken_search_is_not(self):
        # Exit 1 is how every grep says "nothing matched".
        quiet = survey_blank("matches", "grep", exit_code=1)
        self.assertIn("no matches", digest(quiet, "/x"))
        broken = survey_blank("matches", "grep", exit_code=2)
        self.assertIn("NO MATCHES PARSED", digest(broken, "/x"))

    def test_the_headline_names_both_figures_when_they_differ(self):
        res = survey_blank("matches", "rg")
        res.items = [Item(path=f"f{n % 4}.py", line=n, matches=2) for n in range(1, 61)]
        text = digest(res, "/x")
        # The histogram counts matches and the sample counts rows; a headline
        # carrying only the larger figure leaves the two contradicting.
        self.assertIn("120 matches on 60 lines", text)
        self.assertIn("60 matching lines", text)

    def test_a_count_of_one_is_not_pluralised_and_a_match_is_not_a_matchs(self):
        one = survey_blank("matches", "rg")
        one.items = [Item(path="a.py", line=1, matches=1)]
        self.assertIn("1 match in 1 file", digest(one, "/x"))
        many = survey_blank("matches", "rg")
        many.items = [Item(path=f"{n}.py", line=1, matches=1) for n in range(3)]
        self.assertIn("3 matches in 3 files", digest(many, "/x"))

    def test_a_diff_reports_the_stat_shape(self):
        res = survey_blank("diff", "git diff")
        res.items = [Item(path=f"f{n}.py", added=n, deleted=1) for n in range(5)]
        text = digest(res, "/x")
        self.assertIn("5 files changed, +10 −5", text)
        self.assertIn("f4.py  +4 −1", text)


class TestRunnerArgv(unittest.TestCase):
    """The argv each survey runner hands the OS.

    This is the seam the suite used to have no test on. drop_switches() was
    correct about `--` and had a test saying so, and the caller appended tq's
    own format flags past the separator one line later — so `git log -- src`
    grew a pathspec spelled --pretty=format:… , matched nothing, and reported
    no commits with a zero exit. Testing the helper alone could not see it.
    """

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

    def built(self, kind, argv):
        self.cli.RUNNERS[kind](argv, "/sample", "/sample/tmp")
        return self.cmds[-1]

    def test_git_flags_land_after_the_subcommand_not_after_the_pathspec(self):
        self.assertEqual(
            self.built("git-log", ["git", "log", "-3", "--", "home"]),
            ["git", "log", git_runner.COMMIT_FORMAT, "--no-color", "-3", "--", "home"],
        )
        self.assertEqual(
            self.built("git-diff", ["git", "diff", "HEAD", "--", "home"]),
            ["git", "diff", "--numstat", "-z", "--no-color", "HEAD", "--", "home"],
        )
        self.assertEqual(
            self.built("git-ls-files", ["git", "ls-files", "--", "home"]),
            ["git", "ls-files", "-z", "--", "home"],
        )

    def test_git_own_options_keep_their_place_ahead_of_the_verb(self):
        # `git --numstat -C /repo diff` is an error: the flag belongs to the
        # subcommand, so it has to clear git's own options as well as the verb.
        self.assertEqual(
            self.built("git-diff", ["git", "-C", "/repo", "diff", "--", "src"]),
            [
                "git",
                "-C",
                "/repo",
                "diff",
                "--numstat",
                "-z",
                "--no-color",
                "--",
                "src",
            ],
        )

    def test_a_log_asked_for_files_gets_numstat_in_the_same_place(self):
        self.assertEqual(
            self.built("git-log", ["git", "log", "--stat", "--", "home"]),
            [
                "git",
                "log",
                git_runner.COMMIT_FORMAT,
                "--no-color",
                "--numstat",
                "--",
                "home",
            ],
        )

    def test_the_other_surveys_put_their_flags_before_the_operands(self):
        self.assertEqual(
            self.built("ls", ["ls", "-R", "--", "dir"]),
            ["ls", "-1", "-R", "--", "dir"],
        )
        self.assertEqual(
            self.built("rg-files", ["rg", "--files", "--", "dir"]),
            ["rg", "--null", "--files", "--", "dir"],
        )
        self.assertEqual(
            self.built("rg", ["rg", "TODO", "--", "dir"]),
            ["rg", "--json", "TODO", "--", "dir"],
        )
        self.assertEqual(
            self.built("grep", ["grep", "-rn", "TODO", "--", "src"]),
            ["grep", "--null", "-H", "-n", "-rn", "TODO", "--", "src"],
        )
        self.assertEqual(
            self.built("fd", ["fd", "--", "pat", "dir"]),
            ["fd", "--print0", "--", "pat", "dir"],
        )

    def test_find_keeps_its_primary_last(self):
        # The exception, and not an oversight: -print0 is part of find's
        # expression, and an expression is evaluated left to right.
        self.assertEqual(
            self.built("find", ["find", "dir", "-name", "*.py"]),
            ["find", "dir", "-name", "*.py", "-print0"],
        )

    def test_go_test_gets_json_spliced_right_after_the_verb(self):
        self.assertEqual(
            self.built("go-test", ["go", "test", "./..."]),
            ["go", "test", "-json", "./..."],
        )
        self.assertEqual(
            self.built("go-test", ["go", "-C", "sub", "test", "-v", "./..."]),
            ["go", "-C", "sub", "test", "-json", "-v", "./..."],
        )

    def test_go_test_does_not_double_inject_json(self):
        self.assertEqual(
            self.built("go-test", ["go", "test", "-json", "./..."]),
            ["go", "test", "-json", "./..."],
        )

    def test_go_vet_runs_with_no_flags_injected(self):
        self.assertEqual(
            self.built("go-vet", ["go", "vet", "./..."]),
            ["go", "vet", "./..."],
        )

    def test_go_vet_parses_stderr_not_stdout(self):
        # go vet writes its findings to stderr. Parsing stdout instead digests
        # every real run as clean, which is the one failure mode tq exists to
        # prevent.
        class VetProc:
            returncode = 1
            stdout = ""
            stderr = "main.go:12:5: unreachable code\n"

        def fake_run(argv, env):
            return VetProc(), False

        self.addCleanup(setattr, process, "run", process.run)
        process.run = fake_run
        result, _ = lint_runner.run_lint(
            "go-vet", ["go", "vet", "./..."], "/sample", "/sample/tmp"
        )
        self.assertEqual(len(result.failures), 1)
        self.assertEqual(result.failures[0].file, "main.go")

    # The three tables below pin what each lint runner does that is its own:
    # which format flag it takes off, which it puts on, what it calls itself,
    # and which stream it reads. Every one of those is a field rather than
    # logic, and a field is exactly what gets quietly copied wrong.

    LINT_ARGV = (
        # a format flag joined by =, and one that takes a separate value
        ("ruff", ["ruff", "check", "--output-format=grouped", "src"]),
        ("ruff", ["ruff", "check", "-o", "out.txt", "src"]),
        ("mypy", ["mypy", "--output=x", "src"]),
        ("eslint", ["eslint", "-f", "stylish", "src"]),
        ("eslint", ["eslint", "--output-file", "out.json", "src"]),
        ("shellcheck", ["shellcheck", "-f", "gcc", "a.sh"]),
        ("cargo-clippy", ["cargo", "clippy", "--message-format=short"]),
        # tsc and go vet have no format flag to swap: they run as given
        ("tsc", ["tsc", "--noEmit"]),
        ("go-vet", ["go", "vet", "./..."]),
    )
    LINT_EXPECTED = (
        ["ruff", "check", "src", "--output-format=json"],
        ["ruff", "check", "src", "--output-format=json"],
        ["mypy", "src", "--output=json"],
        ["eslint", "src", "--format=json"],
        ["eslint", "src", "--format=json"],
        ["shellcheck", "a.sh", "--format=json1"],
        ["cargo", "clippy", "--message-format=json"],
        ["tsc", "--noEmit"],
        ["go", "vet", "./..."],
    )

    def test_each_lint_runner_swaps_its_own_format_flag_for_tqs(self):
        # Dropping the user's is not cosmetic: each tool resolves a repeated
        # format flag differently, so leaving both would make the digest depend
        # on where in the command the user wrote theirs. Dropping it with the
        # wrong arity instead eats the neighbouring path, and the run then
        # lints the whole tree or nothing at all.
        for (kind, argv), expected in zip(self.LINT_ARGV, self.LINT_EXPECTED):
            with self.subTest(kind=kind, argv=argv):
                self.assertEqual(self.built(kind, argv), expected)

    LINT_IDENTITY = (
        ("ruff", ["ruff", "check", "src"], "ruff"),
        ("mypy", ["mypy", "src"], "mypy"),
        ("eslint", ["eslint", "src"], "eslint"),
        ("tsc", ["tsc", "--noEmit"], "tsc"),
        ("shellcheck", ["shellcheck", "a.sh"], "shellcheck"),
        # neither is named after its subcommand, and both are easy to copy wrong
        ("go-vet", ["go", "vet", "./..."], "go"),
        ("cargo-clippy", ["cargo", "clippy"], "cargo clippy"),
    )

    def test_every_lint_runner_names_itself_and_reports_the_lint_kind(self):
        for kind, argv, runner in self.LINT_IDENTITY:
            with self.subTest(kind=kind):
                result, _ = self.cli.RUNNERS[kind](argv, "/sample", "/sample/tmp")
                self.assertEqual(result.runner, runner)
                # kind drives the whole digest: a lint result that loses it is
                # rendered as a test run with no tests in it.
                self.assertEqual(result.kind, "lint")

    LINT_STREAMS = (
        ("ruff", ["ruff", "check", "src"], "ruff-json.json", "stdout"),
        ("mypy", ["mypy", "src"], "mypy-findings.json", "stdout"),
        ("eslint", ["eslint", "src"], "eslint-findings.json", "stdout"),
        ("tsc", ["tsc", "--noEmit"], "tsc-findings.txt", "stdout"),
        ("shellcheck", ["shellcheck", "a.sh"], "shellcheck-json1.json", "stdout"),
        ("cargo-clippy", ["cargo", "clippy"], "cargo-clippy-findings.json", "stdout"),
        # the odd one out, and the reason this table exists
        ("go-vet", ["go", "vet", "./..."], "go-vet-findings.txt", "stderr"),
    )

    def test_each_lint_runner_reads_the_stream_its_tool_writes_to(self):
        # Reading the wrong one finds nothing and reports CLEAN, so getting
        # this backwards for a tool is invisible until it matters.
        for kind, argv, name, stream in self.LINT_STREAMS:
            with self.subTest(kind=kind, stream=stream):
                findings = read(name)
                for candidate in ("stdout", "stderr"):
                    proc = type(
                        "Proc",
                        (),
                        {
                            "returncode": 1,
                            "stdout": findings if candidate == "stdout" else "",
                            "stderr": findings if candidate == "stderr" else "",
                        },
                    )
                    self.addCleanup(setattr, process, "run", process.run)
                    process.run = lambda argv, env, p=proc: (p(), False)
                    result, _ = self.cli.RUNNERS[kind](argv, "/s", "/s/tmp")
                    if candidate == stream:
                        self.assertTrue(result.failures, f"{kind} read no {stream}")
                    else:
                        self.assertFalse(
                            result.failures, f"{kind} should not read {candidate}"
                        )


class TestBundledShortFlags(unittest.TestCase):
    """Detection has to read a bundle letter by letter.

    `-rl` prints a file list and `-rn` prints matches, and to a membership test
    on whole tokens neither looks like `-l`. tq claimed both and reported the
    26 filenames of a `grep -rl` as one match.
    """

    def test_a_bundle_hiding_another_output_shape_is_not_claimed(self):
        self.assertIsNone(detect_mod.detect(["grep", "-rq", "TODO", "src"]))
        self.assertIsNone(detect_mod.detect(["grep", "-rl", "TODO", "src"]))
        self.assertIsNone(detect_mod.detect(["rg", "-lF", "TODO", "src"]))

    def test_a_bundle_hiding_a_command_runner_is_not_claimed(self):
        # The one that is a safety bug rather than a wrong count: claiming this
        # splices --print0 into the argument list of whatever fd is about to run.
        self.assertIsNone(detect_mod.detect(["fd", "-Hx", "rm", "pat"]))
        self.assertIsNone(detect_mod.detect(["fd", "-HX", "rm", "pat"]))

    def test_a_bundle_without_one_is_still_a_survey(self):
        self.assertEqual(detect_mod.detect(["grep", "-rn", "TODO", "src"]), "grep")
        self.assertEqual(detect_mod.detect(["grep", "-ri", "TODO", "src"]), "grep")
        self.assertEqual(detect_mod.detect(["rg", "-iF", "TODO", "src"]), "rg")
        self.assertEqual(detect_mod.detect(["fd", "-Ht", "f", "pat"]), "fd")

    def test_expansion_stops_where_the_value_starts(self):
        # `-eTODO` is one flag and a pattern. Reading its `o` as --only-matching
        # would have tq decline an ordinary grep — safe, but it gives up the
        # digest on a whole class of real commands.
        self.assertEqual(detect_mod.detect(["grep", "-eTODO", "src"]), "grep")
        # grep spells -r --recursive and rg spells it --replace, so the same
        # bundle has to be read differently for the two tools.
        self.assertEqual(detect_mod.detect(["rg", "-rl", "x", "src"]), "rg")

    def test_past_the_separator_a_flag_is_the_pattern(self):
        self.assertEqual(detect_mod.detect(["grep", "--", "-l", "src"]), "grep")


class TestSurveyMatchesTheBareCommand(unittest.TestCase):
    """Run the real command and check tq's answer against the truth.

    The unit tests above all pass against a tq that answers wrongly, because
    every guard in the digest keys off a non-zero exit or a parse failure and a
    corrupted argv produces neither. Only actually running the thing notices.
    """

    @classmethod
    def setUpClass(cls):
        cls.cli = load_cli()
        cls.dir = tempfile.mkdtemp(prefix="tq-survey-")
        # Two siblings, because the sweeps below count everything under the tree
        # they are given and a repo left inside it would be four more paths.
        cls.tree = os.path.join(cls.dir, "tree")
        cls.repo = os.path.join(cls.dir, "repo")
        os.makedirs(os.path.join(cls.tree, "sub", "deep"))
        for rel in ("a.txt", "sub/b.txt", "sub/deep/c.txt"):
            with open(os.path.join(cls.tree, rel), "w", encoding="utf-8") as handle:
                handle.write("alpha TODO\n")
        os.makedirs(os.path.join(cls.repo, "sub"))
        # Cut off from the machine's git config: a global commit.gpgsign or
        # user.name would otherwise decide whether this fixture can be built.
        cls.env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "tq tests",
            "GIT_AUTHOR_EMAIL": "tq@example.invalid",
            "GIT_COMMITTER_NAME": "tq tests",
            "GIT_COMMITTER_EMAIL": "tq@example.invalid",
        }
        cls._git("init", "-q", "-b", "main")
        for rel in ("a.txt", "sub/b.txt"):
            with open(os.path.join(cls.repo, rel), "w", encoding="utf-8") as handle:
                handle.write("one\n")
            cls._git("add", rel)
            cls._git("commit", "-q", "-m", f"add {rel}")

    @classmethod
    def _git(cls, *args):
        subprocess.run(
            ["git", *args],
            cwd=cls.repo,
            env=cls.env,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def survey(self, kind, argv):
        result, _ = self.cli.RUNNERS[kind](argv, self.dir, self.dir)
        return result

    def test_a_pathspec_past_the_separator_still_reaches_the_paths(self):
        result = self.survey("ls", ["ls", "-R", "--", self.tree])
        self.assertEqual(result.exit, 0)
        self.assertEqual(len(result.items), 5)

    @unittest.skipUnless(shutil.which("git"), "git unavailable")
    def test_a_git_log_narrowed_by_pathspec_finds_its_commits(self):
        # -C rather than a chdir, which also puts a value-taking git option
        # ahead of the verb — the case the splice has to walk past.
        whole = self.survey("git-log", ["git", "-C", self.repo, "log"])
        narrowed = self.survey("git-log", ["git", "-C", self.repo, "log", "--", "sub"])
        self.assertEqual(len(whole.items), 2)
        self.assertEqual(len(narrowed.items), 1)
        self.assertEqual(narrowed.exit, 0)

    @unittest.skipUnless(shutil.which("git"), "git unavailable")
    def test_a_git_diff_narrowed_by_pathspec_finds_its_changes(self):
        result = self.survey(
            "git-diff",
            ["git", "-C", self.repo, "diff", "HEAD~1", "HEAD", "--", "sub"],
        )
        self.assertEqual(result.exit, 0)
        self.assertEqual([item.path for item in result.items], ["sub/b.txt"])

    @unittest.skipUnless(shutil.which("rg"), "rg unavailable")
    def test_an_rg_file_sweep_past_the_separator_exits_clean(self):
        result = self.survey("rg-files", ["rg", "--files", "--", self.tree])
        self.assertEqual(result.exit, 0)
        self.assertEqual(len(result.items), 3)

    def test_a_grep_that_prints_filenames_is_left_to_the_shell(self):
        # Not a tq result at all: detect() declines it, so the agent sees grep's
        # own 3 lines rather than tq's "1 match in 1 file".
        self.assertIsNone(detect_mod.detect(["grep", "-rl", "TODO", self.tree]))


class TestVerdictAgainstRecordedFailures(unittest.TestCase):
    """A PASS headline must never sit above a printed failure.

    Two runners can hand back totals that disagree with the failures they also
    reported — JUnit with failures="0" over a <failure> child, and a node run
    with no run-level summary. The counts were the only vote, so both printed
    PASS with the failure listed underneath it.
    """

    def test_a_recorded_failure_outvotes_a_zero_count(self):
        result = blank("pytest", exit_code=0)
        result.totals.update(tests=3, **{"pass": 3})
        result.failures = [Failure(name="test_a", file="t.py")]
        self.assertTrue(digest(result, "/x").startswith("FAIL 1/3"))

    def test_a_flake_forgiven_as_a_pass_still_reads_pass(self):
        result = blank("pytest", exit_code=0)
        result.totals.update(tests=3, **{"pass": 3})
        result.failures = [Failure(name="test_a", file="t.py", flaky=True)]
        self.assertTrue(digest(result, "/x").startswith("PASS 3/3"))

    def test_agreeing_counts_are_unaffected(self):
        result = blank("pytest", exit_code=0)
        result.totals.update(tests=3, **{"pass": 3})
        self.assertTrue(digest(result, "/x").startswith("PASS 3/3"))


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


class TestSampleReachesBothEnds(unittest.TestCase):
    def test_the_last_item_is_the_last_row(self):
        # Dividing by size put the final sample of 1,412 paths at index 1235 and
        # never showed the tail — the end a truncated answer is most often
        # wrong about, and the one a reader checks to see how far it got.
        items = list(range(1412))
        shown = digest_mod._sample(items, 8)
        self.assertEqual(len(shown), 8)
        self.assertEqual(shown[0], 0)
        self.assertEqual(shown[-1], 1411)

    def test_a_short_list_is_shown_whole(self):
        self.assertEqual(digest_mod._sample([1, 2, 3], 8), [1, 2, 3])
        self.assertEqual(digest_mod._sample([1, 2, 3], 3), [1, 2, 3])

    def test_the_rows_stay_in_order_and_do_not_repeat(self):
        shown = digest_mod._sample(list(range(50)), 8)
        self.assertEqual(shown, sorted(shown))
        self.assertEqual(len(set(shown)), 8)

    def test_a_sample_of_one_does_not_divide_by_zero(self):
        self.assertEqual(digest_mod._sample([1, 2, 3], 1), [1])


SARIF = json.dumps(
    {
        "version": "2.1.0",
        "runs": [
            {
                "tool": {
                    "driver": {
                        "name": "ESLint",
                        "rules": [
                            {
                                "id": "no-unused-vars",
                                "helpUri": "https://eslint.org/x",
                                "defaultConfiguration": {"level": "warning"},
                            }
                        ],
                    }
                },
                "results": [
                    {
                        "ruleId": "no-unused-vars",
                        "level": "error",
                        "message": {"text": "'x' is defined but never used."},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "src/a%20b.js"},
                                    "region": {
                                        "startLine": 3,
                                        "startColumn": 5,
                                        "endLine": 3,
                                        "endColumn": 9,
                                    },
                                }
                            }
                        ],
                        "fixes": [{"description": {"text": "remove"}}],
                    },
                    {
                        "ruleIndex": 0,
                        "message": {"text": "inherits the rule's level"},
                        "locations": [
                            {
                                "physicalLocation": {
                                    "artifactLocation": {"uri": "file:///tmp/c.js"}
                                }
                            }
                        ],
                    },
                ],
            }
        ],
    }
)


class TestSarifAdapter(unittest.TestCase):
    def parsed(self, text):
        result = blank("eslint")
        sarif_adapter.parse(text, result)
        return result.failures

    def test_a_finding_carries_its_rule_location_and_severity(self):
        first = self.parsed(SARIF)[0]
        self.assertEqual(first.name, "no-unused-vars")
        self.assertEqual(first.severity, "error")
        self.assertEqual(first.line, 3)
        self.assertEqual(first.column, 5)
        self.assertEqual(first.end_line, 3)
        self.assertEqual(first.source, "ESLint")
        self.assertEqual(first.code_url, "https://eslint.org/x")
        # SARIF states an edit but never that it preserves behaviour.
        self.assertEqual(first.fixable, "unsafe")

    def test_a_percent_escaped_uri_becomes_a_path(self):
        # Left as a URI it reaches the digest as src/a%20b.js, which no editor
        # opens and no scope check matches against the file on disk.
        self.assertEqual(self.parsed(SARIF)[0].file, "src/a b.js")

    def test_a_file_uri_loses_its_scheme(self):
        self.assertEqual(self.parsed(SARIF)[1].file, "/tmp/c.js")

    def test_a_result_without_a_level_inherits_the_rules(self):
        self.assertEqual(self.parsed(SARIF)[1].severity, "warning")
        self.assertEqual(self.parsed(SARIF)[1].name, "no-unused-vars")

    def test_a_note_is_information_not_a_warning(self):
        text = json.dumps(
            {
                "runs": [
                    {
                        "tool": {"driver": {"name": "x"}},
                        "results": [{"level": "note", "message": {"text": "m"}}],
                    }
                ]
            }
        )
        found = self.parsed(text)
        self.assertEqual(found[0].severity, "info")
        # No location at all is still a finding: unplaceable is not absent.
        self.assertIsNone(found[0].file)

    def test_output_that_is_not_sarif_is_left_to_the_raw_fallback(self):
        self.assertEqual(self.parsed("not json at all"), [])
        self.assertEqual(self.parsed(json.dumps({"diagnostics": []})), [])
        self.assertEqual(self.parsed(json.dumps([1, 2])), [])

    def test_the_cli_offers_it_as_an_ingest_format(self):
        self.assertIn("sarif", load_cli().INGESTORS)


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
