#!/usr/bin/env python3
"""Fixture loading and the scaffolding the tq test modules share.

Each test module puts the tq library on sys.path for itself, so it runs on its
own from any directory. This one repeats that rather than leaning on whoever
imported it, because `from result import Result` below has to resolve at import
time whichever way it was reached.
"""

import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
sys.path.insert(
    0, os.path.join(HERE, os.pardir, os.pardir, "home", "dot_local", "share", "tq")
)

from result import Result


def fixture(name):
    return os.path.join(FIXTURES, name)


def read(name):
    with open(fixture(name), encoding="utf-8") as fh:
        return fh.read()


def blank(runner, exit_code=1, cwd="/sample"):
    return Result(runner=runner, cmd=runner, cwd=cwd, exit=exit_code)


def by_name(result, name):
    return next(f for f in result.failures if f.name == name)


def write_ndjson(records):
    with tempfile.NamedTemporaryFile(
        "w", suffix=".ndjson", delete=False, encoding="utf-8"
    ) as fh:
        for record in records:
            fh.write(json.dumps(record) + "\n")
        return fh.name


def ndjson(records):
    return "\n".join(json.dumps(r) for r in records)


def load_cli():
    """The CLI is `executable_tq` — no .py suffix, so import it by path."""
    path = os.path.join(
        HERE, os.pardir, os.pardir, "home", "dot_local", "bin", "executable_tq"
    )
    spec = importlib.util.spec_from_loader(
        "tq_cli", importlib.machinery.SourceFileLoader("tq_cli", path)
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def survey_blank(kind, runner="find", exit_code=0):
    return Result(runner=runner, kind=kind, cmd=runner, cwd="/sample", exit=exit_code)
