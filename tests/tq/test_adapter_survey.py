#!/usr/bin/env python3
"""The sweep formats: NUL-separated paths, rg --json, grep, numstat, commits."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import survey as survey_adapter
from helpers import (
    survey_blank,
)


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


class TestRecordParsers(unittest.TestCase):
    """journalctl -o json and coredumpctl --json=short."""

    def journal(self, *events):
        raw = "\n".join(json.dumps(e) for e in events)
        return survey_adapter.parse_journal(raw, survey_blank("records", "journalctl"))

    def test_priority_is_named_rather_than_numbered(self):
        # "3" is a severity only to someone holding the syslog table.
        res = self.journal({"MESSAGE": "boom", "PRIORITY": "3", "_COMM": "app"})
        self.assertEqual(res.items[0].status, "err")

    def test_an_unknown_priority_is_passed_through_not_guessed_at(self):
        res = self.journal({"MESSAGE": "x", "PRIORITY": "9", "_COMM": "app"})
        self.assertEqual(res.items[0].status, "9")

    def test_the_user_manager_is_skipped_for_the_identifier_beneath_it(self):
        # Every process in a desktop session reports the same _SYSTEMD_UNIT, so
        # grouping on it puts nearly the whole journal in one bucket.
        res = self.journal(
            {
                "MESSAGE": "hi",
                "_SYSTEMD_UNIT": "user@1000.service",
                "SYSLOG_IDENTIFIER": "discord",
            }
        )
        self.assertEqual(res.items[0].path, "discord")

    def test_a_real_unit_is_kept_over_the_identifier(self):
        res = self.journal(
            {
                "MESSAGE": "hi",
                "_SYSTEMD_UNIT": "sshd.service",
                "SYSLOG_IDENTIFIER": "sshd",
            }
        )
        self.assertEqual(res.items[0].path, "sshd.service")

    def test_a_record_with_no_unit_falls_back_to_the_identifier_then_comm(self):
        # Kernel messages belong to no unit and are exactly what -k asks for.
        self.assertEqual(
            self.journal({"MESSAGE": "x", "SYSLOG_IDENTIFIER": "kernel"}).items[0].path,
            "kernel",
        )
        self.assertEqual(
            self.journal({"MESSAGE": "x", "_COMM": "systemd"}).items[0].path, "systemd"
        )

    def test_a_non_utf8_message_arrives_as_bytes_not_as_a_list_of_ints(self):
        # journald exports an undecodable MESSAGE as an integer array; str() on
        # that would put "[104, 105]" in the digest.
        res = self.journal({"MESSAGE": [104, 105], "_COMM": "app"})
        self.assertEqual(res.items[0].text, "hi")

    def test_a_partial_last_line_from_a_killed_run_is_not_a_record(self):
        raw = json.dumps({"MESSAGE": "one", "_COMM": "app"}) + '\n{"MESSAGE": "tw'
        res = survey_adapter.parse_journal(raw, survey_blank("records", "journalctl"))
        self.assertEqual(len(res.items), 1)

    def test_coredumps_are_keyed_on_the_executable_not_the_pid(self):
        # A histogram over pids has one bucket per row; the question a crash
        # list answers is which program keeps failing.
        raw = json.dumps(
            [
                {"exe": "/usr/bin/bash", "pid": 1, "sig": 11, "corefile": "present"},
                {"exe": "/usr/bin/bash", "pid": 2, "sig": 11, "corefile": "present"},
            ]
        )
        res = survey_adapter.parse_coredumps(
            raw, survey_blank("records", "coredumpctl")
        )
        self.assertEqual({i.path for i in res.items}, {"/usr/bin/bash"})
        self.assertEqual([i.status for i in res.items], ["SIGSEGV", "SIGSEGV"])

    def test_an_unnamed_signal_is_numbered_rather_than_guessed(self):
        raw = json.dumps([{"exe": "/x", "pid": 1, "sig": 5, "corefile": "present"}])
        res = survey_adapter.parse_coredumps(
            raw, survey_blank("records", "coredumpctl")
        )
        self.assertEqual(res.items[0].status, "sig 5")

    def test_a_missing_core_is_said_because_the_count_cannot_show_it(self):
        # A listed crash whose core was never written cannot be debugged.
        raw = json.dumps([{"exe": "/x", "pid": 7, "sig": 6, "corefile": "missing"}])
        res = survey_adapter.parse_coredumps(
            raw, survey_blank("records", "coredumpctl")
        )
        self.assertIn("core missing", res.items[0].text)

    def test_output_that_is_not_the_listing_claims_nothing(self):
        for raw in ("", "not json", "{}", "null"):
            res = survey_adapter.parse_coredumps(
                raw, survey_blank("records", "coredumpctl")
            )
            self.assertEqual(res.items, [], raw)


if __name__ == "__main__":
    unittest.main(verbosity=1)
