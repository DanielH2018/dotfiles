#!/usr/bin/env python3
"""Which adapter owns a command — the question the PreToolUse hook asks."""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

import cmdline
import detect as detect_mod
from helpers import (
    load_cli,
)


class TestDetection(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_launchers_and_python_m_are_seen_through(self):
        self.assertEqual(
            detect_mod.tool_name(["uv", "run", "python", "-m", "pytest"]), "pytest"
        )
        self.assertEqual(detect_mod.tool_name(["uv", "run", "ruff", "check"]), "ruff")
        self.assertEqual(detect_mod.tool_name(["/usr/bin/node", "--test"]), "node")
        self.assertEqual(detect_mod.tool_name(["env", "FOO=1", "pytest"]), "pytest")

    def test_a_command_that_merely_names_a_runner_is_not_one(self):
        # Scanning every token for the runner's name turns `grep pytest notes`
        # into a test run, and injects reporter flags into the grep. Since greps
        # became a survey the answer is no longer None, but it is still the
        # program that was actually run and never the one it was looking for.
        self.assertEqual(self.cli.detect(["grep", "pytest", "notes.txt"]), "grep")
        self.assertEqual(self.cli.detect(["grep", "shellcheck", "notes.txt"]), "grep")
        self.assertIsNone(self.cli.detect(["cat", "pytest", "notes.txt"]))

    def test_ruff_format_is_not_a_diagnostics_run(self):
        self.assertIsNone(self.cli.detect(["ruff", "format", "--check", "."]))
        self.assertEqual(self.cli.detect(["ruff", "check", "."]), "ruff")

    def test_each_known_runner_is_claimed(self):
        self.assertEqual(self.cli.detect(["node", "--test", "x.js"]), "node")
        self.assertEqual(self.cli.detect(["shellcheck", "x.sh"]), "shellcheck")
        self.assertEqual(self.cli.detect(["prek", "run", "--all-files"]), "prek")
        self.assertIsNone(self.cli.detect(["node", "x.js"]))  # no --test

    def test_cargo_subcommands_are_routed_and_everything_else_passes_through(self):
        self.assertEqual(self.cli.detect(["cargo", "clippy"]), "cargo-clippy")
        self.assertEqual(self.cli.detect(["cargo", "test"]), "cargo-test")
        # build, run, publish and anything else cargo grows later: never
        # claimed, the same principle as git's "everything but log/diff
        # passes through" — a wrapper that captures stdout must never decide
        # a subcommand was safe to reinterpret.
        self.assertIsNone(self.cli.detect(["cargo", "build"]))
        self.assertIsNone(self.cli.detect(["cargo", "run"]))
        self.assertIsNone(self.cli.detect(["cargo"]))

    def test_cargo_global_options_are_skipped_to_find_the_verb(self):
        self.assertEqual(
            detect_mod.cargo_subcommand(
                ["cargo", "--manifest-path", "x/Cargo.toml", "test"]
            ),
            "test",
        )
        self.assertEqual(
            detect_mod.cargo_subcommand(["cargo", "-v", "clippy"]), "clippy"
        )

    def test_drop_flag_removes_either_spelling(self):
        self.assertEqual(
            cmdline.drop_flag(
                ["ruff", "check", "--output-format=json", "x"], ("--output-format",)
            ),
            ["ruff", "check", "x"],
        )
        self.assertEqual(
            cmdline.drop_flag(["shellcheck", "-f", "json", "x"], ("-f",)),
            ["shellcheck", "x"],
        )

    def test_go_test_and_go_vet_are_claimed_by_their_subcommand(self):
        self.assertEqual(self.cli.detect(["go", "test", "./..."]), "go-test")
        self.assertEqual(self.cli.detect(["go", "vet", "./..."]), "go-vet")

    def test_other_go_subcommands_pass_through_untouched(self):
        for argv in (
            ["go", "build", "./..."],
            ["go", "run", "main.go"],
            ["go", "get", "x"],
            ["go", "mod", "tidy"],
            ["go"],
        ):
            self.assertIsNone(self.cli.detect(argv), argv)

    def test_gos_own_flag_ahead_of_the_verb_does_not_hide_it(self):
        self.assertEqual(detect_mod.go_subcommand(["go", "-C", "sub", "test"]), "test")
        self.assertEqual(self.cli.detect(["go", "-C", "sub", "vet", "./..."]), "go-vet")

    def test_gradle_test_is_claimed_in_either_spelling(self):
        self.assertEqual(self.cli.detect(["gradle", "test"]), "gradle-test")
        self.assertEqual(self.cli.detect(["./gradlew", "test"]), "gradle-test")
        self.assertEqual(
            self.cli.detect(["gradle", "test", "--tests", "FooTest"]), "gradle-test"
        )

    def test_gradle_build_and_check_pass_through_untouched(self):
        # gradle's default lifecycle also runs tests under `build`/`check`,
        # but claiming that requires understanding the lifecycle binding —
        # out of scope. Only an explicit `test` task is claimed.
        self.assertIsNone(self.cli.detect(["gradle", "build"]))
        self.assertIsNone(self.cli.detect(["gradle", "check"]))
        self.assertIsNone(self.cli.detect(["gradle"]))

    def test_gradle_task_token_must_be_exact_not_a_substring(self):
        # "testCompile" merely contains "test" — the same care FIND_UNSAFE
        # and the grep letter sets take elsewhere against a substring match.
        self.assertIsNone(self.cli.detect(["gradle", "testCompile"]))

    def test_mvn_test_is_claimed(self):
        self.assertEqual(self.cli.detect(["mvn", "test"]), "mvn-test")
        self.assertEqual(self.cli.detect(["mvn", "clean", "test"]), "mvn-test")
        self.assertEqual(self.cli.detect(["mvn", "-pl", "module", "test"]), "mvn-test")

    def test_mvn_install_and_verify_pass_through_untouched(self):
        # `mvn install`/`mvn verify` also run tests as part of Maven's default
        # lifecycle, but same principle as gradle build/check: out of scope.
        self.assertIsNone(self.cli.detect(["mvn", "install"]))
        self.assertIsNone(self.cli.detect(["mvn", "verify"]))
        self.assertIsNone(self.cli.detect(["mvn"]))


class TestSurveyDetection(unittest.TestCase):
    def setUp(self):
        self.cli = load_cli()

    def test_only_the_read_only_git_subcommands_are_claimed(self):
        self.assertEqual(self.cli.detect(["git", "log", "--oneline"]), "git-log")
        self.assertEqual(self.cli.detect(["git", "diff", "HEAD"]), "git-diff")
        self.assertEqual(self.cli.detect(["git", "-C", "/repo", "log"]), "git-log")
        # A wrapper that captures stdout must never be the thing that decides a
        # mutation was safe, so everything else runs untouched.
        self.assertIsNone(self.cli.detect(["git", "commit", "-m", "x"]))
        self.assertIsNone(self.cli.detect(["git", "push"]))
        self.assertIsNone(self.cli.detect(["git", "-C", "/repo", "reset", "--hard"]))
        self.assertIsNone(self.cli.detect(["git"]))

    def test_a_find_that_runs_or_reformats_is_not_a_sweep(self):
        self.assertEqual(self.cli.detect(["find", ".", "-name", "*.py"]), "find")
        for action in (["-delete"], ["-exec", "rm", "{}", ";"], ["-printf", "%p"]):
            self.assertIsNone(self.cli.detect(["find", ".", *action]), action)

    def test_grep_flags_that_change_the_answer_shape_pass_through(self):
        self.assertEqual(self.cli.detect(["grep", "-rn", "x", "."]), "grep")
        self.assertEqual(self.cli.detect(["rg", "x", "."]), "rg")
        # `rg --files` takes no pattern at all; --json would reject it.
        self.assertEqual(self.cli.detect(["rg", "--files"]), "rg-files")
        for flag in ("-c", "-l", "-L", "-q", "-o"):
            self.assertIsNone(self.cli.detect(["grep", flag, "x", "."]), flag)

    def test_ls_is_a_sweep_only_when_recursive_and_not_long(self):
        self.assertEqual(self.cli.detect(["ls", "-R", "src"]), "ls")
        self.assertEqual(self.cli.detect(["ls", "-aR", "src"]), "ls")
        self.assertIsNone(self.cli.detect(["ls", "src"]))
        # -lR bundles a long listing: those lines carry permissions, not paths.
        self.assertIsNone(self.cli.detect(["ls", "-lR", "src"]))

    def test_a_diff_asked_for_its_status_is_left_alone(self):
        # --exit-code makes the status the answer. The survey headline reads a
        # non-zero status as an incomplete enumeration, so the two cannot share
        # a command without one of them lying.
        self.assertIsNone(self.cli.detect(["git", "diff", "--exit-code"]))
        self.assertIsNone(self.cli.detect(["git", "diff", "--quiet"]))


class TestBundledShortFlags(unittest.TestCase):
    """Detection has to read a bundle letter by letter.

    `-rl` prints a file list and `-rn` prints matches, and to a membership test
    on whole tokens neither looks like `-l`. tq claimed both and reported the
    26 filenames of a `grep -rl` as one match.
    """

    def test_a_bundle_hiding_another_output_shape_is_not_claimed(self):
        self.assertIsNone(detect_mod.detect(["grep", "-rq", "TODO", "src"]))
        self.assertIsNone(detect_mod.detect(["grep", "-rl", "TODO", "src"]))
        self.assertIsNone(detect_mod.detect(["rg", "-lF", "TODO", "src"]))

    def test_a_bundle_hiding_a_command_runner_is_not_claimed(self):
        # The one that is a safety bug rather than a wrong count: claiming this
        # splices --print0 into the argument list of whatever fd is about to run.
        self.assertIsNone(detect_mod.detect(["fd", "-Hx", "rm", "pat"]))
        self.assertIsNone(detect_mod.detect(["fd", "-HX", "rm", "pat"]))

    def test_a_bundle_without_one_is_still_a_survey(self):
        self.assertEqual(detect_mod.detect(["grep", "-rn", "TODO", "src"]), "grep")
        self.assertEqual(detect_mod.detect(["grep", "-ri", "TODO", "src"]), "grep")
        self.assertEqual(detect_mod.detect(["rg", "-iF", "TODO", "src"]), "rg")
        self.assertEqual(detect_mod.detect(["fd", "-Ht", "f", "pat"]), "fd")

    def test_expansion_stops_where_the_value_starts(self):
        # `-eTODO` is one flag and a pattern. Reading its `o` as --only-matching
        # would have tq decline an ordinary grep — safe, but it gives up the
        # digest on a whole class of real commands.
        self.assertEqual(detect_mod.detect(["grep", "-eTODO", "src"]), "grep")
        # grep spells -r --recursive and rg spells it --replace, so the same
        # bundle has to be read differently for the two tools.
        self.assertEqual(detect_mod.detect(["rg", "-rl", "x", "src"]), "rg")

    def test_past_the_separator_a_flag_is_the_pattern(self):
        self.assertEqual(detect_mod.detect(["grep", "--", "-l", "src"]), "grep")


class TestRecordDetection(unittest.TestCase):
    """journalctl and coredumpctl: claimed only where wrapping is an improvement."""

    def test_a_journal_query_is_claimed_only_once_it_is_bounded(self):
        # tq buffers what it wraps, and the journal is unbounded by default, so
        # an unnarrowed query under tq reads the whole archive into memory as
        # JSON where the bare command would have paged the tail.
        self.assertIsNone(detect_mod.detect(["journalctl"]))
        for bound in (
            ["-n", "50"],
            ["-n50"],
            ["--lines=50"],
            ["--since", "today"],
            ["-u", "sshd"],
            ["-b"],
            ["-p", "err"],
            ["-k"],
        ):
            self.assertEqual(
                detect_mod.detect(["journalctl", *bound]), "journalctl", bound
            )

    def test_a_journal_command_that_writes_or_never_ends_is_left_alone(self):
        # --follow never returns and tq builds its digest only after the process
        # exits, so wrapping one hangs where the bare command streams.
        for unsafe in (
            ["-f", "-u", "sshd"],
            ["--follow", "-n", "10"],
            ["--vacuum-time=2d"],
            ["--vacuum-size=1G"],
            ["--rotate"],
            ["--disk-usage"],
            ["--list-boots"],
            ["--verify"],
        ):
            self.assertIsNone(detect_mod.detect(["journalctl", *unsafe]), unsafe)

    def test_a_journal_command_that_picked_its_own_format_keeps_it(self):
        # tq would overwrite -o with its own; a command that named a shape is
        # asking for that shape, the same rule --null gives grep.
        self.assertIsNone(detect_mod.detect(["journalctl", "-n", "5", "-o", "cat"]))
        self.assertIsNone(detect_mod.detect(["journalctl", "-n", "5", "--output=cat"]))

    def test_coredumpctl_lists_by_default_and_only_list_is_claimed(self):
        # A bare `coredumpctl` lists, which is the opposite of a bare `git`.
        self.assertEqual(detect_mod.detect(["coredumpctl"]), "coredumpctl")
        self.assertEqual(detect_mod.detect(["coredumpctl", "list"]), "coredumpctl")
        self.assertEqual(
            detect_mod.detect(["coredumpctl", "-n", "5", "list"]), "coredumpctl"
        )
        # info reports per core, dump writes the core out, debug goes interactive.
        for verb in ("dump", "debug", "info"):
            self.assertIsNone(detect_mod.detect(["coredumpctl", verb]), verb)

    def test_coredumpctl_output_flag_writes_a_core_and_is_not_a_listing(self):
        # -o is an output *file* here, not a format — a mutation wearing the
        # name of the flag that is harmless everywhere else in tq.
        self.assertIsNone(detect_mod.detect(["coredumpctl", "-o", "/tmp/core", "list"]))
        self.assertIsNone(detect_mod.detect(["coredumpctl", "--output=/tmp/c", "list"]))
        self.assertIsNone(detect_mod.detect(["coredumpctl", "--json=pretty", "list"]))
        self.assertIsNone(detect_mod.detect(["coredumpctl", "-F", "exe", "list"]))


if __name__ == "__main__":
    unittest.main(verbosity=1)
