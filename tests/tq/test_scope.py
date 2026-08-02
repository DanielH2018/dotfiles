#!/usr/bin/env python3
"""Narrowing findings to what the diff touched, against a real repo."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import scope
from digest import digest
from result import Failure, Result


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
