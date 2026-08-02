"""Linters and type checkers: ask for a machine format, parse it, note stderr.

Every tool here is run the same way, and the seven of them differ only in the
five fields of Tool below. They were seven near-identical functions until the
duplication started hiding things — a stream read from the wrong attribute or a
format flag dropped with the wrong arity looks like the other six at a glance.
As a table the differences are the only thing on the page.

A tool tq has never heard of goes through run_ingested instead, which takes the
format from --ingest rather than from a row here.
"""

from __future__ import annotations

import functools
import os
import shlex
from dataclasses import dataclass
from typing import Callable

import cmdline
import process
from adapters import lint as lint_adapter
from adapters import rdjson as rdjson_adapter
from adapters import sarif as sarif_adapter
from result import Result


@dataclass(frozen=True)
class Tool:
    """What one linter needs that the others do not. No behaviour lives here.

    `drop` is the tool's own format flag, taken off the command because each
    tool resolves a repeated one differently — by position for some, by
    precedence for others — and a digest must not change shape when the user
    reorders their command. `add` is tq's, put on in its place.
    """

    runner: str
    parse: Callable[[str, Result], None]
    drop: tuple[str, ...] = ()
    add: str = ""
    stream: str = "stdout"


TOOLS = {
    "ruff": Tool(
        runner="ruff",
        parse=lint_adapter.parse_ruff,
        drop=("--output-format", "--output-file", "-o"),
        add="--output-format=json",
    ),
    "mypy": Tool(
        runner="mypy",
        parse=lint_adapter.parse_mypy,
        drop=("--output",),
        add="--output=json",
    ),
    "eslint": Tool(
        runner="eslint",
        parse=lint_adapter.parse_eslint,
        drop=("--format", "-f", "--output-file", "-o"),
        add="--format=json",
    ),
    # tsc has no machine format to ask for; adapters/lint.py reads its text.
    "tsc": Tool(runner="tsc", parse=lint_adapter.parse_tsc),
    "shellcheck": Tool(
        runner="shellcheck",
        parse=lint_adapter.parse_shellcheck,
        drop=("--format", "-f"),
        add="--format=json1",
    ),
    # go vet writes its findings to stderr, not stdout — get this backwards
    # and every real run digests as clean.
    "go-vet": Tool(runner="go", parse=lint_adapter.parse_go_vet, stream="stderr"),
    "cargo-clippy": Tool(
        runner="cargo clippy",
        parse=lint_adapter.parse_cargo_clippy,
        drop=("--message-format",),
        add="--message-format=json",
    ),
}


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


def run_lint(name, argv, workdir, tmp):
    tool = TOOLS[name]
    cmd = cmdline.drop_flag(argv, tool.drop)
    if tool.add:
        cmd = cmd + [tool.add]
    proc, timed_out = process.run(cmd, process.plain_env())
    result = Result(
        runner=tool.runner,
        kind="lint",
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )
    tool.parse(getattr(proc, tool.stream), result)
    finish_lint(result, proc)
    return result, proc


def runner_for(name):
    """One tool's entry for the CLI's RUNNERS table, bound to its row above."""
    return functools.partial(run_lint, name)


INGESTORS = {
    "rdjson": rdjson_adapter.parse,
    "ruff-json": lint_adapter.parse_ruff,
    "sarif": sarif_adapter.parse,
    "shellcheck-json1": lint_adapter.parse_shellcheck,
}


def run_ingested(argv, workdir, tmp, fmt):
    """Any command at all, as long as its stdout speaks a format tq reads.

    The escape hatch from tq's fixed list of runners: a linter tq has never
    heard of still gets digested, and one it cannot be taught still runs. It
    stays outside TOOLS because the runner name comes from the command and the
    parser from --ingest, so there is no row to look up.
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
