#!/usr/bin/env python3
"""The sweep runners against real commands, checked on the truth."""

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

import detect as detect_mod
from helpers import (
    load_cli,
)


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
