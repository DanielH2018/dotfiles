"""git's read-only subcommands, which are surveys wearing git's name.

log, diff and ls-files answer with a list, so they build the same Result shape
as find and rg and reuse survey.py's helpers. What is git-specific is where the
flags land — past git's own options and past the subcommand, never past a `--`.
"""

from __future__ import annotations

import cmdline
import process
from adapters import survey as survey_adapter
from runners.survey import finish_survey, note_limit, survey

# Flags that choose how git renders a diff or a log. Dropped rather than merged
# with tq's own: git resolves a repeated format flag by position for some of
# these and by precedence for others, so a digest that let both stand would
# change shape when the user reordered their command.
DIFF_FORMATS = (
    "--stat",
    "--numstat",
    "--shortstat",
    "--dirstat",
    "--compact-summary",
    "--name-only",
    "--name-status",
    "--summary",
    "--raw",
    "--color",
    "-p",
    "--patch",
    "-u",
)
LOG_FORMATS = DIFF_FORMATS + (
    "--oneline",
    "--graph",
    "--pretty",
    "--format",
    "--abbrev-commit",
)
# Sentinel-led so the numstat rows that follow a commit can be told from it.
COMMIT_FORMAT = "--pretty=format:%x1e%H%x1f%an%x1f%aI%x1f%s"
# git log flags that ask for per-file detail. tq adds --numstat only when one of
# them was given: a 500-commit log is fast until it has to diff every commit.
LOG_WANTS_FILES = (
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "-p",
    "--patch",
)


def git_env():
    env = process.plain_env()
    # A pager attached to a captured pipe is not a risk git takes, but a
    # configured one that ignores isatty is, and it would hang the run.
    env["GIT_PAGER"] = "cat"
    return env


def run_git_diff(argv, workdir, tmp):
    cmd = cmdline.git_inject(
        cmdline.drop_switches(argv, DIFF_FORMATS), ["--numstat", "-z", "--no-color"]
    )
    proc, timed_out = process.run(cmd, git_env())
    result = survey("git diff", "diff", argv, workdir, proc, timed_out)
    survey_adapter.parse_numstat(proc.stdout, result)
    finish_survey(result, proc)
    return result, proc


def run_git_ls_files(argv, workdir, tmp):
    proc, timed_out = process.run(cmdline.git_inject(argv, ["-z"]), git_env())
    result = survey("git ls-files", "paths", argv, workdir, proc, timed_out)
    survey_adapter.parse_paths(proc.stdout, result)
    finish_survey(result, proc)
    return result, proc


def run_git_log(argv, workdir, tmp):
    flags = [COMMIT_FORMAT, "--no-color"]
    if any(tok in argv for tok in LOG_WANTS_FILES):
        flags.append("--numstat")
    cmd = cmdline.git_inject(cmdline.drop_switches(argv, LOG_FORMATS), flags)
    proc, timed_out = process.run(cmd, git_env())
    result = survey("git log", "commits", argv, workdir, proc, timed_out)
    survey_adapter.parse_commits(proc.stdout, result)
    limit, spelling = cmdline.count_limit(argv, ("--max-count", "-n"), bare=True)
    note_limit(result, limit, spelling)
    finish_survey(result, proc)
    return result, proc
