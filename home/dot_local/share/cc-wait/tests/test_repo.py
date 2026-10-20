"""Repo probes, driven end to end through `cli.main` against a throwaway repository."""

import io

from conftest import write_probe

from cc_wait import cli
from cc_wait.builtins import BUILTINS

LANDED = """\
if [ "$1" = --describe ]; then
  echo '{"terminal": {"settled": 0, "deploy-failed": 1, "gave-up": 3}, "interval_s": 1}'
  exit 0
fi
echo '{"state": "settled", "detail": "PR #'"$1"' deployed"}'
"""


def run(cwd, *argv):
    out = io.StringIO()
    code = cli.main(list(argv), out=out, cwd=cwd, env={})
    return code, out.getvalue().splitlines()


def test_a_tracked_probe_ends_the_wait_with_its_declared_code(repo):
    write_probe(repo, "land", LANDED)
    code, lines = run(repo, "land", "3501")
    assert code == 0
    assert lines == ["WAIT: settled PR #3501 deployed"]


def test_an_untracked_probe_is_refused(repo):
    write_probe(repo, "land", LANDED, track=False)
    code, lines = run(repo, "land", "3501")
    assert code == 2
    assert "not tracked by git" in lines[0]


def test_a_probe_named_like_a_built_in_is_refused(repo):
    write_probe(repo, "file", LANDED)
    code, lines = run(repo, "file", "x", "--pid", "1")
    assert code == 2
    assert "same name as the built-in" in lines[0]


def test_a_probe_declaring_a_reserved_code_is_refused(repo):
    write_probe(
        repo,
        "land",
        """echo '{"terminal": {"settled": 0, "gave-up": 75}}'\n""",
    )
    code, lines = run(repo, "land", "3501")
    assert code == 2
    assert "reserved exit code" in lines[0]


def test_list_names_the_built_ins_and_this_repo_s_probes(repo):
    write_probe(repo, "land", LANDED)
    code, lines = run(repo, "--list")
    assert code == 0
    names = [line.split()[0] for line in lines]
    # Built-ins in registry order, then the repo's probes. A copied list of built-in names was
    # hand-edited each time a source was added.
    assert names == [*BUILTINS, "land"]


# Like argparse, --help wins over every other argument, --describe included.
ARGPARSE_PROBE = """\
case " $* " in
  *" --help "* | *" -h "*) echo 'usage: land [-h] pr'; echo '  pr  the PR to wait on' ;;
  *" --describe "*) echo '{"terminal": {"settled": 0, "failed": 1}}' ;;
esac
"""


def test_a_trailing_help_prints_the_probe_s_own_help(repo):
    write_probe(repo, "land", ARGPARSE_PROBE)
    for argv in (["land", "--help"], ["land", "3501", "-h"]):
        code, lines = run(repo, *argv)
        assert code == 0
        assert lines[:2] == ["usage: land [-h] pr", "  pr  the PR to wait on"]
        assert lines[3] == "cc-wait's own option, for every source:"


def test_a_probe_whose_help_fails_is_refused_with_its_whole_stderr(repo):
    write_probe(repo, "land", "echo 'usage: land pr' >&2\nprintf 'x%.0s' $(seq 500) >&2\nexit 2\n")
    code, lines = run(repo, "land", "--help")
    assert code == 2
    assert "--help exited 2: usage: land pr" in lines[0]
