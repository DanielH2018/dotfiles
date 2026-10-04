"""Repo probes, driven end to end through `cli.main` against a throwaway repository."""

import io

from conftest import write_probe

from cc_wait import cli

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
    assert names == ["file", "exit", "gh-pr", "gh-ci", "land"]
