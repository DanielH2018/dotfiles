#!/usr/bin/env python3
"""SARIF, for tools reached through --ingest."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from adapters import sarif as sarif_adapter
from helpers import (
    blank,
    load_cli,
)

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


if __name__ == "__main__":
    unittest.main(verbosity=1)
