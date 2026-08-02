"""Path and match sweeps: find, fd, ls -R, rg, grep.

These do not fail or pass, so nothing here builds failures — the digest reads
result.items and reports the shape of the answer. What each runner has to get
right is the format flag: a NUL-separated listing, because a filename may
contain a newline and splitting on one would report a single path as two.
"""

from __future__ import annotations

import shlex

import cmdline
import detect
import process
from adapters import survey as survey_adapter
from result import Result


def survey(runner, kind, argv, workdir, proc, timed_out):
    return Result(
        runner=runner,
        kind=kind,
        cmd=shlex.join(argv),
        cwd=workdir,
        exit=proc.returncode,
        timed_out=timed_out,
    )


def finish_survey(result, proc):
    """Whatever the command said on stderr, when it is not already the answer.

    find writes one "Permission denied" per unreadable directory and keeps
    going, which is exactly the case where the count is short and nothing in
    stdout says so.
    """
    note = (proc.stderr or "").strip()
    if note:
        result.notes.append(note)


def note_limit(result, limit, spelling):
    """Record the cap only when the command actually ran into it. `git log -n 50`
    that found 12 commits was not limited by anything — there were 12."""
    if limit is not None and len(result.items) >= limit:
        result.limited = spelling


def run_find(argv, workdir, tmp):
    cmd = list(argv)
    if not any(tok in detect.FIND_OPERATORS for tok in argv):
        # Only where appending cannot change which paths come back. With an -o
        # in the expression `-print0` binds to the last branch alone, so the
        # command is left as it stands and the output split on newlines.
        cmd = ["-print0" if tok == "-print" else tok for tok in cmd]
        if "-print0" not in cmd:
            cmd.append("-print0")
    proc, timed_out = process.run(cmd, process.plain_env())
    result = survey("find", "paths", argv, workdir, proc, timed_out)
    survey_adapter.parse_paths(proc.stdout, result)
    finish_survey(result, proc)
    return result, proc


def run_fd(argv, workdir, tmp):
    cmd = list(argv)
    if not any(tok in ("-0", "--print0") for tok in cmd):
        cmd = cmdline.inject(cmd, ["--print0"])
    proc, timed_out = process.run(cmd, process.plain_env())
    result = survey("fd", "paths", argv, workdir, proc, timed_out)
    survey_adapter.parse_paths(proc.stdout, result)
    limit, spelling = cmdline.count_limit(argv, ("--max-results",))
    note_limit(result, limit, spelling)
    finish_survey(result, proc)
    return result, proc


def run_ls(argv, workdir, tmp):
    proc, timed_out = process.run(cmdline.inject(argv, ["-1"]), process.plain_env())
    result = survey("ls", "paths", argv, workdir, proc, timed_out)
    survey_adapter.parse_ls_r(proc.stdout, result)
    finish_survey(result, proc)
    return result, proc


def run_rg_files(argv, workdir, tmp):
    proc, timed_out = process.run(cmdline.inject(argv, ["--null"]), process.plain_env())
    result = survey("rg", "paths", argv, workdir, proc, timed_out)
    survey_adapter.parse_paths(proc.stdout, result)
    finish_survey(result, proc)
    return result, proc


def run_rg(argv, workdir, tmp):
    proc, timed_out = process.run(cmdline.inject(argv, ["--json"]), process.plain_env())
    result = survey("rg", "matches", argv, workdir, proc, timed_out)
    survey_adapter.parse_rg_json(proc.stdout, result)
    limit, spelling = cmdline.count_limit(argv, ("--max-count", "-m"))
    note_limit(result, limit, spelling)
    finish_survey(result, proc)
    return result, proc


def run_grep(argv, workdir, tmp):
    proc, timed_out = process.run(
        cmdline.inject(argv, ["--null", "-H", "-n"]), process.plain_env()
    )
    result = survey("grep", "matches", argv, workdir, proc, timed_out)
    survey_adapter.parse_grep(proc.stdout, result)
    limit, spelling = cmdline.count_limit(argv, ("--max-count", "-m"))
    note_limit(result, limit, spelling)
    finish_survey(result, proc)
    return result, proc
