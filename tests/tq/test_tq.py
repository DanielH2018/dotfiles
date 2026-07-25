#!/usr/bin/env python3
"""Unit tests for the tq adapters and digest, against fixtures captured from
real pytest and node --test runs. Run directly: python3 tests/tq/test_tq.py"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import junit as junit_adapter
from adapters import node as node_adapter
from digest import digest
from result import Failure, Result, strip_ansi


def fixture(name):
    return os.path.join(FIXTURES, name)


def read(name):
    with open(fixture(name), encoding="utf-8") as fh:
        return fh.read()


def blank(runner, exit_code=1, cwd="/sample"):
    return Result(runner=runner, cmd=runner, cwd=cwd, exit=exit_code)


def by_name(result, name):
    return next(f for f in result.failures if f.name == name)


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
                "cmd",
                "cwd",
                "exit",
                "duration_ms",
                "totals",
                "failures",
                "truncated",
            },
        )
        self.assertEqual(
            set(payload["failures"][0]),
            {"file", "line", "name", "message", "stdout", "stderr"},
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


class TestTextHelpers(unittest.TestCase):
    def test_strip_ansi_handles_both_real_and_xml_escaped_forms(self):
        self.assertEqual(strip_ansi("\x1b[32m+ actual\x1b[39m"), "+ actual")
        self.assertEqual(strip_ansi("#x1B[1m#x1B[31mtest.py#x1B[0m"), "test.py")

    def test_strip_ansi_keeps_diff_markers(self):
        # node marks actual-vs-expected with colour only when FORCE_COLOR is
        # set; with it unset the +/- prefixes are real text and must survive.
        self.assertEqual(strip_ansi("\x1b[32m+ '/tmp/x'\x1b[39m"), "+ '/tmp/x'")


if __name__ == "__main__":
    unittest.main(verbosity=1)
