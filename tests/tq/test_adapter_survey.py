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


if __name__ == "__main__":
    unittest.main(verbosity=1)
