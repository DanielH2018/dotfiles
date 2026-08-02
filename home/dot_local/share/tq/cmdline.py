"""Editing the command tq was handed before it runs.

Every runner has to take its tool's own format flag off the command and put
tq's on, and where each lands is the part that keeps being subtly wrong — past
a `--` a token is a path, and git rejects options that follow operands. The
rules live here rather than in each runner so there is one place they are true.
"""

from __future__ import annotations

import re

import detect

BARE_COUNT = re.compile(r"^-(\d+)$")


def drop_flag(argv, flags):
    """argv without a flag tq is about to set for itself, in either spelling."""
    out, skip = [], False
    for tok in argv:
        if skip:
            skip = False
            continue
        if tok in flags:
            skip = True  # its value is the next token
            continue
        if any(tok.startswith(f"{flag}=") for flag in flags):
            continue
        out.append(tok)
    return out


def drop_switches(argv, flags):
    """argv without the valueless format flags tq is about to replace.

    Everything from `--` onward is kept whatever it spells: past that separator
    a token is a path, and a file genuinely named --stat is still a file.
    """
    out = []
    for i, tok in enumerate(argv):
        if tok == "--":
            out.extend(argv[i:])
            break
        if tok in flags or any(tok.startswith(f"{flag}=") for flag in flags):
            continue
        out.append(tok)
    return out


def inject(argv, flags, after=1):
    """argv with the flags tq needs spliced in ahead of the operands.

    Appending them is what reads naturally and is wrong everywhere it matters.
    Past a `--` every token is a path, so `git log -- src` would grow a pathspec
    spelled --pretty=format:… , match nothing and report no commits; git rejects
    options after operands even with no separator in sight; and a `--print0`
    trailing `fd pat dir` is a second directory to search.
    """
    return list(argv[:after]) + list(flags) + list(argv[after:])


def git_inject(argv, flags):
    """inject(), landing past git's own options and the subcommand."""
    i = detect.git_subcommand_index(argv)
    return inject(argv, flags, after=i + 1 if i >= 0 else 1)


def count_limit(argv, names, bare=False):
    """The cap a command put on its own output, as (number, how it was spelled).

    Only the flags that stop the search early. -maxdepth and a pathspec narrow
    what is being asked about, which is the question rather than a limit on the
    answer; -n stops a complete answer part-way through.
    """
    for i, tok in enumerate(argv):
        if bare and BARE_COUNT.match(tok):
            return int(BARE_COUNT.match(tok).group(1)), tok
        for name in names:
            if tok == name and i + 1 < len(argv) and argv[i + 1].isdigit():
                return int(argv[i + 1]), f"{name} {argv[i + 1]}"
            value = tok[len(name) + 1 :] if tok.startswith(f"{name}=") else ""
            if value.isdigit():
                return int(value), tok
            short = tok[len(name) :] if len(name) == 2 and tok.startswith(name) else ""
            if short.isdigit():
                return int(short), tok
    return None, ""
