"""Test runners: run the suite, then read the report it wrote.

None of these parse a runner's human output. Each asks its runner for a machine
format first — node's reporter protocol, pytest's JUnit XML, `go test -json`,
Gradle's and Maven's per-class XML — because a suite's console output is the one
thing its authors feel free to restyle. cargo test is the exception: it has no
machine format short of nightly, so adapters/cargo.py parses the text.
"""

from __future__ import annotations

import contextlib
import glob
import os
import shlex

import process
from adapters import cargo as cargo_adapter
from adapters import go as go_adapter
from adapters import junit as junit_adapter
from adapters import node as node_adapter
from detect import go_subcommand_index
from result import Result

LIB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORTER = os.path.join(LIB, "node-reporter.mjs")


def pytest_env(xml_path, last_failed=False):
    """pytest takes its flags through the environment because prek offers no
    argument passthrough, and PYTEST_ADDOPTS survives `uv run` either way."""
    env = process.plain_env()
    flags = [
        f"--junit-xml={shlex.quote(xml_path)}",
        "-o junit_logging=out-err",
        "-o junit_log_passing_tests=false",
        "--tb=short",
        "-q",
    ]
    if last_failed:
        # pytest's own cache names the failures exactly, parametrised cases
        # included — far better than anything tq could rebuild from a report.
        flags.append("--last-failed")
    env["PYTEST_ADDOPTS"] = " ".join([env.get("PYTEST_ADDOPTS", ""), *flags]).strip()
    return env


def parse_junit(xml_path, result, summary_text=""):
    """Parse a JUnit report if there is a readable one, else leave the result be.

    Deliberately broad: a report tq cannot parse must degrade to the raw output
    main() already prints for an unreported failure, never to a traceback in
    place of the digest. A killed runner is the common way to get half a file.
    """
    if not os.path.exists(xml_path):
        return
    with contextlib.suppress(Exception):  # deliberately broad — see above
        junit_adapter.parse(xml_path, result, summary_text=summary_text)


def parse_junit_reports(paths, result):
    """Merge every JUnit report in `paths` into `result` — Gradle and Maven
    write one XML file per test class rather than pytest's single report, so
    there is no one path to hand to parse_junit().

    junit_adapter.parse() recomputes result.totals and result.duration_ms
    from scratch on every call — it assigns, it does not accumulate — so
    calling it straight on `result` for a second file would silently discard
    the first file's counts. Only result.failures is safe to grow directly,
    since parse() appends into whatever list it is given. So each report is
    parsed into a throwaway Result and its totals/duration summed in by hand.
    """
    for path in paths:
        if not os.path.exists(path):
            continue
        with contextlib.suppress(Exception):  # deliberately broad — see above
            scratch = Result(
                runner=result.runner, cmd=result.cmd, cwd=result.cwd, exit=0
            )
            junit_adapter.parse(path, scratch)
            for key, value in scratch.totals.items():
                result.totals[key] += value
            result.duration_ms += scratch.duration_ms
            result.failures.extend(scratch.failures)


def run_node(argv, workdir, tmp, rerun_state=None):
    ndjson = os.path.join(tmp, "events.ndjson")
    cmd = list(argv)
    at = cmd.index("--test") + 1
    cmd[at:at] = [
        f"--test-reporter={REPORTER}",
        f"--test-reporter-destination={ndjson}",
    ]
    if rerun_state:
        # node keeps its own record of what has passed and reruns the rest, so
        # the flag goes on both attempts: the first writes it, the second reads
        # it. Nothing here has to name a test or reconstruct an id.
        cmd[at:at] = [f"--test-rerun-failures={rerun_state}"]
    proc, timed_out = process.run(cmd, process.plain_env())
    result = Result(
        runner="node",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    if os.path.exists(ndjson):
        node_adapter.parse(ndjson, result)
    return result, proc


def run_pytest(argv, workdir, tmp, last_failed=False):
    xml = os.path.join(tmp, "junit.xml")
    proc, timed_out = process.run(argv, pytest_env(xml, last_failed))
    result = Result(
        runner="pytest",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    parse_junit(xml, result, summary_text=proc.stdout)
    return result, proc


def run_prek(argv, workdir, tmp):
    xml = os.path.join(tmp, "junit.xml")
    proc, timed_out = process.run(argv, pytest_env(xml))
    result = Result(
        runner="prek",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    parse_junit(xml, result, summary_text=proc.stdout)
    return result, proc


def run_go_test(argv, workdir, tmp):
    cmd = list(argv)
    if "-json" not in cmd and "--json" not in cmd:
        i = go_subcommand_index(cmd)
        at = i + 1 if i >= 0 else len(cmd)
        cmd[at:at] = ["-json"]
    proc, timed_out = process.run(cmd, process.plain_env())
    result = Result(
        runner="go",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    go_adapter.parse_go_test(proc.stdout, result)
    return result, proc


def run_cargo_test(argv, workdir, tmp):
    proc, timed_out = process.run(argv, process.plain_env())
    result = Result(
        runner="cargo test",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    cargo_adapter.parse_cargo_test(proc.stdout, result)
    return result, proc


def run_junit_report_glob(runner, argv, workdir, pattern):
    """Run `argv` as given, then glob `pattern` under `workdir` for whatever
    JUnit XML report files it produced and merge them into one Result.

    Shared by Gradle and Maven, whose only difference is where each writes
    its reports — both run untouched (no flags to inject, matching every
    other test-runner run_*) and both leave zero XML behind on a run that
    never reached a test class, which is left as an all-zero totals for
    digest.py's existing NO TESTS RAN / "exited N with no reported failures"
    fallback to describe rather than something new here.
    """
    proc, timed_out = process.run(argv, process.plain_env())
    result = Result(
        runner=runner,
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    # sorted(): glob order is not guaranteed stable across runs, and a digest
    # that reorders findings between two identical runs is worth avoiding.
    paths = sorted(glob.glob(pattern, recursive=True))
    parse_junit_reports(paths, result)
    return result, proc


def run_gradle_test(argv, workdir, tmp):
    pattern = os.path.join(workdir, "**", "build", "test-results", "test", "TEST-*.xml")
    return run_junit_report_glob("gradle", argv, workdir, pattern)


def run_mvn_test(argv, workdir, tmp):
    pattern = os.path.join(workdir, "**", "target", "surefire-reports", "TEST-*.xml")
    return run_junit_report_glob("mvn", argv, workdir, pattern)
