#!/usr/bin/env python3
"""The linters' and type checkers' machine formats."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import junit as junit_adapter
from adapters import lint as lint_adapter
from digest import digest
from helpers import (
    blank,
    by_name,
    fixture,
    read,
)


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
