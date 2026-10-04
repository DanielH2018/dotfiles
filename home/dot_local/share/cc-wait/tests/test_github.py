"""`gh-pr` and `gh-ci` against a fake `gh`: canned API data in, a state out."""

import json
import subprocess

import pytest

from cc_wait import github
from cc_wait.source import ReadError, SourceError, validate

SHA = "1f0e7c4a9b2d5e6f8a0c1b3d4e5f6071a2b3c4d5"


def gh(responses: dict[str, object], calls: list | None = None):
    """A runner answering `gh` by the first two words of its arguments, as JSON."""

    def run(cmd, **_kwargs):
        if calls is not None:
            calls.append(cmd)
        key = " ".join(cmd[1:3])
        if key not in responses:
            return subprocess.CompletedProcess(cmd, 1, "", f"no fake for {key}")
        return subprocess.CompletedProcess(cmd, 0, json.dumps(responses[key]), "")

    return run


def runs(*pairs):
    return {"check_runs": [{"name": n, "status": s, "conclusion": c} for n, s, c in pairs]}


def ci(responses, **kwargs):
    wait = github.CiWait("o/r", kwargs.get("ref", SHA), kwargs.get("pr"), gh(responses))
    validate(wait.describe())
    return wait.read()


def test_all_runs_completed_without_a_failure_passed():
    data = runs(("prek", "completed", "success"), ("renovate", "completed", "skipped"))
    assert ci({f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": data}).state == "passed"


def test_one_failed_run_fails_the_wait_while_others_still_run():
    data = runs(("prek", "completed", "failure"), ("pytest", "in_progress", None))
    reading = ci({f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": data})
    assert (reading.state, reading.detail) == ("failed", f"{SHA[:8]}: 1 failed: prek")


def test_runs_still_in_progress_are_running():
    data = runs(("prek", "completed", "success"), ("pytest", "queued", None))
    reading = ci({f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": data})
    assert (reading.state, reading.detail) == ("running", f"{SHA[:8]}: 1/2 check runs complete")


def test_no_check_runs_yet_is_pending_never_passed():
    reading = ci({f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": runs()})
    assert reading.state == "pending"


def test_a_cancelled_run_with_no_failure_is_cancelled():
    data = runs(("prek", "completed", "cancelled"), ("lint", "completed", "success"))
    assert ci({f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": data}).state == "cancelled"


def test_pr_mode_reads_the_head_commit_each_time():
    """A push to the pull request between two reads moves the wait to the new head."""
    pushed = "2" * 40
    responses = {
        "pr view": {"headRefOid": SHA},
        f"api repos/o/r/commits/{SHA}/check-runs?per_page=100": runs(("p", "completed", "failure")),
        f"api repos/o/r/commits/{pushed}/check-runs?per_page=100": runs(
            ("p", "completed", "success")
        ),
    }
    wait = github.CiWait("o/r", None, "7", gh(responses))
    assert wait.read().state == "failed"
    responses["pr view"] = {"headRefOid": pushed}
    assert wait.read().state == "passed"


def test_gh_failing_is_a_read_error_the_loop_retries():
    with pytest.raises(ReadError, match="no fake"):
        ci({})


@pytest.mark.parametrize(("state", "expected"), [("MERGED", "merged"), ("CLOSED", "closed")])
def test_a_pull_request_that_left_open_ends_the_wait(state, expected):
    wait = github.PrWait("o/r", "7", gh({"pr view": {"state": state}}))
    assert wait.read().state == expected
    assert wait.describe().terminal[expected] == (0 if expected == "merged" else 1)


def test_an_open_pull_request_says_whether_auto_merge_is_armed():
    armed = {"state": "OPEN", "mergeable": "MERGEABLE", "autoMergeRequest": {"x": 1}}
    unarmed = {"state": "OPEN", "mergeable": "MERGEABLE", "autoMergeRequest": None}
    reading = github.PrWait("o/r", "7", gh({"pr view": armed})).read()
    assert reading.state == "open"
    assert "auto-merge armed" in reading.detail
    reading = github.PrWait("o/r", "7", gh({"pr view": unarmed})).read()
    assert "auto-merge armed" not in reading.detail


def test_the_repo_comes_from_the_origin_remote(tmp_path):
    def remote(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 0, "git@github.com:DanielH2018/server.git\n", "")

    assert github.repo_for(None, tmp_path, remote) == "DanielH2018/server"


def test_a_directory_with_no_github_remote_needs_repo(tmp_path):
    def none(cmd, **_kwargs):
        return subprocess.CompletedProcess(cmd, 2, "", "no such remote")

    with pytest.raises(SourceError, match="--repo"):
        github.repo_for(None, tmp_path, none)


def test_gh_ci_takes_a_sha_or_a_pr_not_both():
    with pytest.raises(SourceError, match="not both"):
        github.CiSource().bind([SHA, "--pr", "7", "--repo", "o/r"])


def test_the_bound_source_s_repr_names_no_process_specific_runner():
    """cc-wait keys its shared cache on repr(bound); a function's address differs per process."""
    wait = github.CiWait("o/r", SHA, None)
    assert repr(wait) == f"CiWait(repo='o/r', ref='{SHA}', pr=None)"
