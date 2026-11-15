"""`gh-pr` and `gh-ci` against a fake `ghread`: canned API data in, a state out."""

import io
import json
import os
import subprocess
import time
from datetime import UTC, datetime

import pytest

from cc_wait import github, loop
from cc_wait.source import ReadError, Reading, SourceError, validate

SHA = "1f0e7c4a9b2d5e6f8a0c1b3d4e5f6071a2b3c4d5"
NOW = 1_800_000_000.0
RUNS = f"api repos/o/r/commits/{SHA}/check-runs?per_page=100"
SUITES = f"api repos/o/r/commits/{SHA}/check-suites?per_page=100"
ACTIONS = f"api repos/o/r/actions/runs?head_sha={SHA}&per_page=100"


def gh(responses: dict[str, object], calls: list | None = None):
    """A runner answering `ghread` by the first two words of its arguments, as JSON."""

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


def suites(*triples):
    """Check suites as (status, check run count, seconds old); one old completed suite if none."""
    triples = triples or (("completed", 1, 600),)
    return {
        "check_suites": [
            {
                "status": status,
                "latest_check_runs_count": count,
                "created_at": datetime.fromtimestamp(NOW - age, UTC).isoformat(),
            }
            for status, count, age in triples
        ]
    }


def ci(responses, **kwargs):
    responses.setdefault(SUITES, suites())
    responses.setdefault(ACTIONS, {"workflow_runs": []})
    wait = github.CiWait(
        "o/r", kwargs.get("ref", SHA), kwargs.get("pr"), gh(responses), now=lambda: NOW
    )
    validate(wait.describe())
    return wait.read()


def test_all_runs_completed_without_a_failure_passed():
    data = runs(("prek", "completed", "success"), ("renovate", "completed", "skipped"))
    assert ci({RUNS: data}).state == "passed"


def test_one_failed_run_fails_the_wait_while_others_still_run():
    data = runs(("prek", "completed", "failure"), ("pytest", "in_progress", None))
    reading = ci({RUNS: data})
    assert (reading.state, reading.detail) == ("failed", f"{SHA[:8]}: 1 failed: prek")


def test_runs_still_in_progress_are_running():
    data = runs(("prek", "completed", "success"), ("pytest", "queued", None))
    reading = ci({RUNS: data})
    assert (reading.state, reading.detail) == ("running", f"{SHA[:8]}: 1/2 check runs complete")


def test_no_check_runs_yet_is_pending_never_passed():
    reading = ci({RUNS: runs()})
    assert reading.state == "pending"


def numbered(*quads):
    """Check runs as (id, name, status, conclusion), for a commit with several runs of a check."""
    return {
        "check_runs": [{"id": i, "name": n, "status": s, "conclusion": c} for i, n, s, c in quads]
    }


def test_a_cancelled_run_superseded_by_a_green_run_passes():
    """Issue #1098: GitHub cancelled a queued CI run; a newer run of the same check passed."""
    data = numbered((11, "prek", "completed", "cancelled"), (12, "prek", "completed", "success"))
    assert ci({RUNS: data}).state == "passed"


@pytest.mark.parametrize("conclusion", ["cancelled", "stale"])
def test_a_check_whose_only_run_gave_no_verdict_keeps_waiting(conclusion):
    data = runs(("prek", "completed", conclusion), ("lint", "completed", "success"))
    reading = ci({RUNS: data})
    assert (reading.state, reading.detail) == (
        "cancelled",
        f"{SHA[:8]}: 1 runs gave no verdict: prek",
    )
    assert reading.state not in github.CiWait("o/r", SHA, None).describe().terminal


def test_a_cancelled_workflow_run_superseded_by_a_finished_one_passes():
    data = runs(("prek", "completed", "success"))
    workflow_runs = {
        "workflow_runs": [
            {
                "id": 11,
                "workflow_id": 5,
                "name": "CI",
                "status": "completed",
                "conclusion": "cancelled",
            },
            {
                "id": 12,
                "workflow_id": 5,
                "name": "CI",
                "status": "completed",
                "conclusion": "success",
            },
        ]
    }
    assert ci({RUNS: data, ACTIONS: workflow_runs}).state == "passed"


def test_a_suite_still_running_holds_a_pass_until_its_check_runs_register():
    """PR #4071: GitGuardian's one run finished before the Actions suite registered any."""
    data = runs(("GitGuardian Security Checks", "completed", "success"))
    reading = ci({RUNS: data, SUITES: suites(("completed", 1, 40), ("queued", 0, 40))})
    assert reading.state == "passed"
    reading = ci({RUNS: data, SUITES: suites(("completed", 1, 40), ("in_progress", 4, 40))})
    assert (reading.state, reading.detail) == (
        "running",
        f"{SHA[:8]}: 1 check runs complete; 1 check suites still running",
    )


def test_a_suite_younger_than_the_settle_time_holds_a_pass():
    data = runs(("GitGuardian Security Checks", "completed", "success"))
    reading = ci({RUNS: data, SUITES: suites(("completed", 1, 3), ("queued", 0, 2))})
    assert (reading.state, reading.detail) == (
        "running",
        f"{SHA[:8]}: 1 check runs complete; 2 check suites under 30s old",
    )


def test_a_workflow_run_queued_with_no_check_runs_holds_a_pass():
    """Issue #851: CI queued behind a cancelled run past the settle time, its suite still empty."""
    data = runs(("GitGuardian Security Checks", "completed", "success"))
    old_empty = suites(("completed", 1, 600), ("queued", 0, 600))
    queued = {"workflow_runs": [{"name": "CI", "status": "pending"}]}
    reading = ci({RUNS: data, SUITES: old_empty, ACTIONS: queued})
    assert (reading.state, reading.detail) == (
        "running",
        f"{SHA[:8]}: 1 check runs complete; 1 workflow runs not completed: CI",
    )
    finished = {"workflow_runs": [{"name": "CI", "status": "completed"}]}
    assert ci({RUNS: data, SUITES: old_empty, ACTIONS: finished}).state == "passed"


def test_a_workflow_run_that_failed_before_any_check_run_fails_the_wait():
    """Issue #953: an invalid workflow file ends `startup_failure` and registers no check run."""
    broken = {
        "workflow_runs": [{"name": "CI", "status": "completed", "conclusion": "startup_failure"}]
    }
    data = runs(("GitGuardian Security Checks", "completed", "success"))
    reading = ci({RUNS: data, ACTIONS: broken})
    assert (reading.state, reading.detail) == ("failed", f"{SHA[:8]}: 1 workflow runs failed: CI")
    assert ci({RUNS: runs(), ACTIONS: broken}).state == "failed"


def test_a_short_sha_is_resolved_before_the_workflow_runs_are_read():
    """`actions/runs?head_sha=` returns nothing for an abbreviated SHA, so a queued CI run hid."""
    data = runs(("GitGuardian Security Checks", "completed", "success"))
    queued = {"workflow_runs": [{"name": "CI", "status": "queued"}]}
    responses = {
        f"api repos/o/r/commits/{SHA[:8]}": {"sha": SHA},
        RUNS: data,
        ACTIONS: queued,
        f"api repos/o/r/actions/runs?head_sha={SHA[:8]}&per_page=100": {"workflow_runs": []},
    }
    reading = ci(responses, ref=SHA[:8])
    assert (reading.state, reading.detail) == (
        "running",
        f"{SHA[:8]}: 1 check runs complete; 1 workflow runs not completed: CI",
    )


def test_pr_mode_reads_the_head_commit_each_time():
    """A push to the pull request between two reads moves the wait to the new head."""
    pushed = "2" * 40
    responses = {
        "pr view": {"headRefOid": SHA},
        RUNS: runs(("p", "completed", "failure")),
        f"api repos/o/r/commits/{pushed}/check-runs?per_page=100": runs(
            ("p", "completed", "success")
        ),
        f"api repos/o/r/commits/{pushed}/check-suites?per_page=100": suites(),
        f"api repos/o/r/actions/runs?head_sha={pushed}&per_page=100": {"workflow_runs": []},
    }
    wait = github.CiWait("o/r", None, "7", gh(responses), now=lambda: NOW)
    assert wait.read().state == "failed"
    responses["pr view"] = {"headRefOid": pushed}
    assert wait.read().state == "passed"


DIGEST = "CI / pytest (job 9)\n  FAILED tests/test_x.py::test_y\n"


def with_digest(responses, calls, digest=(0, DIGEST, "")):
    """`gh` plus a plain-text answer to `ghread run failures`, which prints no JSON."""
    json_run = gh(responses, calls)

    def run(cmd, **kwargs):
        if cmd[1:3] == ["run", "failures"]:
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, *digest)
        return json_run(cmd, **kwargs)

    return run


def test_a_red_wait_prints_each_failed_job_s_tests_after_the_verdict():
    calls = []
    responses = {RUNS: runs(("pytest", "completed", "failure"))}
    wait = github.CiWait("o/r", SHA, None, with_digest(responses, calls), now=lambda: NOW)
    out = io.StringIO()
    code = loop.run(wait, 60, "cc-wait gh-ci", out=out, wait_change=lambda *_: None)
    assert code == 1
    assert out.getvalue().splitlines() == [
        f"WAIT: failed {SHA[:8]}: 1 failed: pytest",
        "CI / pytest (job 9)",
        "  FAILED tests/test_x.py::test_y",
    ]
    assert calls[-1] == ["ghread", "run", "failures", SHA, "-R", "o/r"]


def test_a_pr_wait_digests_the_pull_request_s_head():
    calls = []
    wait = github.CiWait("o/r", None, "7", with_digest({}, calls))
    assert wait.digest(Reading("failed", "x")) == DIGEST
    assert calls == [["ghread", "run", "failures", "--pr", "7", "-R", "o/r"]]


@pytest.mark.parametrize("state", ["passed", "running", "cancelled"])
def test_only_a_failed_wait_spends_the_digest_s_gh_calls(state):
    calls = []
    assert github.CiWait("o/r", SHA, None, with_digest({}, calls)).digest(Reading(state)) == ""
    assert calls == []


def test_a_digest_ghread_could_not_produce_names_the_command_to_run():
    wait = github.CiWait("o/r", SHA, None, with_digest({}, [], (4, "", "HTTP 502")))
    assert wait.digest(Reading("failed")) == (
        f"no failure digest: ghread exited 4: HTTP 502; run: ghread run failures {SHA} -R o/r"
    )


def test_gh_failing_is_a_read_error_the_loop_retries():
    with pytest.raises(ReadError, match="no fake"):
        ci({})


def test_every_read_goes_through_ghread_never_bare_gh():
    """ghread is what counts a read in the host's GitHub quota ledger."""
    calls = []
    responses = {
        "pr view": {"headRefOid": SHA, "state": "OPEN"},
        RUNS: runs(("p", "completed", "success")),
        SUITES: suites(),
        ACTIONS: {"workflow_runs": []},
    }
    github.CiWait("o/r", None, "7", gh(responses, calls), now=lambda: NOW).read()
    github.PrWait("o/r", "7", gh(responses, calls)).read()
    assert {cmd[0] for cmd in calls} == {"ghread"}


def test_a_timed_out_read_also_kills_the_gh_that_ghread_started(tmp_path, monkeypatch):
    pid_file = tmp_path / "gh.pid"
    ghread = tmp_path / "ghread"
    ghread.write_text(f"#!/bin/sh\nsleep 60 &\necho $! > {pid_file}\nwait\n")
    ghread.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    monkeypatch.setattr(github, "GH_TIMEOUT_S", 1)
    with pytest.raises(ReadError, match="ghread did not run: .*timed out"):
        github.gh_json(["pr", "view", "7"])
    gh_pid = int(pid_file.read_text())
    deadline = time.monotonic() + 5
    while _alive(gh_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(gh_pid)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


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
