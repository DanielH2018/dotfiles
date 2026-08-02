#!/usr/bin/env python3
"""What the digest says, and what it must never say."""

import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import digest as digest_mod
from adapters import junit as junit_adapter
from adapters import lint as lint_adapter
from digest import MAX_DIGEST, digest
from helpers import (
    blank,
    fixture,
    survey_blank,
)
from result import Failure, Item, Result, strip_ansi


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


class TestRecordDigest(unittest.TestCase):
    def records(self, exit_code=0, items=()):
        res = survey_blank("records", "coredumpctl", exit_code=exit_code)
        res.items = list(items)
        return res

    def test_an_empty_crash_list_is_an_answer_not_a_failed_enumeration(self):
        # coredumpctl exits 1 when there are no coredumps, which on a healthy
        # machine is every run. Reporting that as NO RECORDS PARSED would raise
        # an alarm on precisely the case worth being quiet about.
        self.assertTrue(
            digest(self.records(exit_code=1), "/x").startswith("no records")
        )

    def test_a_real_failure_above_exit_1_still_says_so(self):
        self.assertTrue(
            digest(self.records(exit_code=2), "/x").startswith("NO RECORDS PARSED")
        )

    def test_the_span_a_record_set_covers_is_in_the_headline(self):
        res = self.records(
            items=[
                Item(path="a", status="SIGSEGV", date="2026-07-31 09:00:00"),
                Item(path="b", status="SIGABRT", date="2026-08-02 10:00:00"),
            ]
        )
        self.assertIn("2 records", digest(res, "/x"))
        self.assertIn("2026-07-31..2026-08-02", digest(res, "/x"))

    def test_severity_is_only_broken_out_when_it_separates_anything(self):
        # Past MAX_ROWS, where the digest stands in for the rows rather than
        # printing them — under it there is no histogram of anything to test.
        # `journalctl -p err` already said every record is an err; a histogram
        # of it spends a line restating the flag.
        same = self.records(
            items=[
                Item(path=f"u{i}", status="err", date="2026-08-02 09:00:00")
                for i in range(60)
            ]
        )
        self.assertIsNone(
            re.search(r"^\s+err\s+60$", digest(same, "/x"), re.M),
            "a single severity is the query restating itself",
        )
        mixed = self.records(
            items=[
                Item(
                    path=f"u{i}",
                    status="err" if i % 2 else "info",
                    date="2026-08-02 09:00:00",
                )
                for i in range(60)
            ]
        )
        text = digest(mixed, "/x")
        self.assertRegex(text, r"(?m)^\s+err\s+30$")
        self.assertRegex(text, r"(?m)^\s+info\s+30$")


if __name__ == "__main__":
    unittest.main(verbosity=1)
