#!/usr/bin/env python3
"""Unit tests for the tq adapters and digest, against fixtures captured from
real pytest and node --test runs. Run directly: python3 tests/tq/test_tq.py"""

import os
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

import scope
from adapters import junit as junit_adapter
from adapters import lint as lint_adapter
from adapters import node as node_adapter
from adapters import rdjson as rdjson_adapter
from digest import MAX_DIGEST, digest
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
                "kind",
                "cmd",
                "cwd",
                "exit",
                "timed_out",
                "duration_ms",
                "attempts",
                "totals",
                "failures",
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
            self.cli.tool_name(["uv", "run", "python", "-m", "pytest"]), "pytest"
        )
        self.assertEqual(self.cli.tool_name(["uv", "run", "ruff", "check"]), "ruff")
        self.assertEqual(self.cli.tool_name(["/usr/bin/node", "--test"]), "node")
        self.assertEqual(self.cli.tool_name(["env", "FOO=1", "pytest"]), "pytest")

    def test_a_command_that_merely_names_a_runner_is_not_one(self):
        # Scanning every token for the runner's name turns `grep pytest notes`
        # into a test run, and injects reporter flags into the grep.
        self.assertIsNone(self.cli.detect(["grep", "pytest", "notes.txt"]))
        self.assertIsNone(self.cli.detect(["grep", "shellcheck", "notes.txt"]))

    def test_ruff_format_is_not_a_diagnostics_run(self):
        self.assertIsNone(self.cli.detect(["ruff", "format", "--check", "."]))
        self.assertEqual(self.cli.detect(["ruff", "check", "."]), "ruff")

    def test_each_known_runner_is_claimed(self):
        self.assertEqual(self.cli.detect(["node", "--test", "x.js"]), "node")
        self.assertEqual(self.cli.detect(["shellcheck", "x.sh"]), "shellcheck")
        self.assertEqual(self.cli.detect(["prek", "run", "--all-files"]), "prek")
        self.assertIsNone(self.cli.detect(["node", "x.js"]))  # no --test

    def test_drop_flag_removes_either_spelling(self):
        self.assertEqual(
            self.cli.drop_flag(
                ["ruff", "check", "--output-format=json", "x"], ("--output-format",)
            ),
            ["ruff", "check", "x"],
        )
        self.assertEqual(
            self.cli.drop_flag(["shellcheck", "-f", "json", "x"], ("-f",)),
            ["shellcheck", "x"],
        )


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

    def test_a_killed_runner_yields_its_partial_output_as_text(self):
        tq = load_cli()
        tq.TIMEOUT = 1
        proc, timed_out = tq.run(self.sleeper(), os.environ.copy())
        self.assertTrue(timed_out)
        self.assertEqual(proc.returncode, 124)
        # TimeoutExpired carries bytes even under text=True, and no returncode
        # at all — both have to be normalised or the digest blows up on a hang.
        self.assertIsInstance(proc.stdout, str)
        self.assertIn("ran a bit", proc.stdout)

    def test_a_runner_that_finishes_is_not_marked_timed_out(self):
        tq = load_cli()
        tq.TIMEOUT = 30
        proc, timed_out = tq.run(
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
