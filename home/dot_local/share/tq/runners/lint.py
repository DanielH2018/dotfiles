"""Linters and type checkers: ask for a machine format, parse it, note stderr.

Each of these runs the tool with its own `--format`-alike stripped and tq's
put on, because a repeated format flag is resolved differently by each tool
and the digest must not depend on where in the command the user wrote theirs.
"""

from __future__ import annotations

import os
import shlex

import cmdline
import process
from adapters import lint as lint_adapter
from adapters import rdjson as rdjson_adapter
from adapters import sarif as sarif_adapter
from result import Result


def finish_lint(result, proc):
    """Counts restated as findings, plus whatever the tool said on stderr.

    That stderr matters: a linter reports "I examined nothing" there and still
    exits 0, which is indistinguishable from a clean run by exit code alone.
    """
    lint_adapter.as_diagnostics(result)
    note = (proc.stderr or "").strip()
    # Only when the run looks clean. A failing run already has main() print the
    # raw output, and saying the same thing twice buries the one line that counts.
    if note and result.exit == 0:
        result.notes.append(note)


def run_ruff(argv, workdir, tmp):
    cmd = cmdline.drop_flag(argv, ("--output-format", "--output-file", "-o"))
    proc, timed_out = process.run(cmd + ["--output-format=json"], process.plain_env())
    result = Result(
        runner="ruff",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_ruff(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


def run_mypy(argv, workdir, tmp):
    cmd = cmdline.drop_flag(argv, ("--output",))
    proc, timed_out = process.run(cmd + ["--output=json"], process.plain_env())
    result = Result(
        runner="mypy",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_mypy(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


def run_eslint(argv, workdir, tmp):
    cmd = cmdline.drop_flag(argv, ("--format", "-f", "--output-file", "-o"))
    proc, timed_out = process.run(cmd + ["--format=json"], process.plain_env())
    result = Result(
        runner="eslint",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_eslint(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


def run_tsc(argv, workdir, tmp):
    proc, timed_out = process.run(argv, process.plain_env())
    result = Result(
        runner="tsc",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_tsc(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


def run_shellcheck(argv, workdir, tmp):
    cmd = cmdline.drop_flag(argv, ("--format", "-f"))
    proc, timed_out = process.run(cmd + ["--format=json1"], process.plain_env())
    result = Result(
        runner="shellcheck",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_shellcheck(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


def run_go_vet(argv, workdir, tmp):
    proc, timed_out = process.run(argv, process.plain_env())
    result = Result(
        runner="go",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    # go vet writes its findings to stderr, not stdout — get this backwards
    # and every real run digests as clean.
    lint_adapter.parse_go_vet(proc.stderr, result)
    finish_lint(result, proc)
    return result, proc


def run_cargo_clippy(argv, workdir, tmp):
    cmd = cmdline.drop_flag(argv, ("--message-format",))
    proc, timed_out = process.run(cmd + ["--message-format=json"], process.plain_env())
    result = Result(
        runner="cargo clippy",
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    lint_adapter.parse_cargo_clippy(proc.stdout, result)
    finish_lint(result, proc)
    return result, proc


INGESTORS = {
    "rdjson": rdjson_adapter.parse,
    "ruff-json": lint_adapter.parse_ruff,
    "sarif": sarif_adapter.parse,
    "shellcheck-json1": lint_adapter.parse_shellcheck,
}


def run_ingested(argv, workdir, tmp, fmt):
    """Any command at all, as long as its stdout speaks a format tq reads.

    The escape hatch from tq's fixed list of runners: a linter tq has never
    heard of still gets digested, and one it cannot be taught still runs.
    """
    proc, timed_out = process.run(argv, process.plain_env())
    result = Result(
        runner=os.path.basename(argv[0]),
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    INGESTORS[fmt](proc.stdout, result)
    finish_lint(result, proc)
    return result, proc
