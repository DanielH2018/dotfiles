#!/usr/bin/env python3
"""The argv each runner hands the OS, and the fields that differ per tool."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import process
from helpers import (
    load_cli,
    read,
)
from runners import git as git_runner
from runners import lint as lint_runner


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

    # The format flags the record runners splice in, and where they land. On
    # TestRunnerArgv rather than a subclass of it: unittest collects inherited
    # methods too, so a subclass would run the whole parent suite a second time
    # — which tq-digest.test.js catches as more tests run than declared.
    def test_journalctl_asks_for_json_ahead_of_the_operands(self):
        self.assertEqual(
            self.built("journalctl", ["journalctl", "-u", "sshd", "-n", "20"]),
            ["journalctl", "-o", "json", "--no-pager", "-u", "sshd", "-n", "20"],
        )

    def test_coredumpctl_json_lands_before_the_verb(self):
        # coredumpctl takes its options ahead of the subcommand; appending
        # --json past `list` is not where it is read.
        self.assertEqual(
            self.built("coredumpctl", ["coredumpctl", "list"]),
            ["coredumpctl", "--json=short", "--no-pager", "list"],
        )

    def test_a_self_capped_query_is_reported_as_capped(self):
        # The count is what the command was allowed to find, not what is there.
        self.addCleanup(setattr, process, "run", process.run)
        process.run = lambda argv, env: (self.Proc(), False)
        result, _ = self.cli.RUNNERS["journalctl"](
            ["journalctl", "-n", "0"], "/s", "/s/tmp"
        )
        self.assertEqual(result.limited, "-n 0")


if __name__ == "__main__":
    unittest.main(verbosity=1)
