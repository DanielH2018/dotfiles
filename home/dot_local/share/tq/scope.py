"""Narrowing a linter's findings to the change that is actually being made.

A linter run over a repo reports everything wrong with the repo. An agent that
edited twenty lines is answerable for a few of those, and the rest are older
than its session — but they arrive in the same digest, at the same cost, and
they bury the ones it caused.

Only ever the digest is narrowed. The json keeps every finding, because a
finding outside the diff is still true; what changes is which ones are worth
spending the agent's context on.

Test failures are deliberately never scoped. A test that breaks in a file the
diff never touched is the single most valuable thing a run can report, and
"you did not edit that line" is no reason to hide it.
"""

from __future__ import annotations

import os
import re
import subprocess

# @@ -old,count +new,count @@ — the new-side span is where a finding now sits.
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(?P<start>\d+)(?:,(?P<count>\d+))? @@")

MODES = ("all", "file", "added")

# A file git has never seen is new all the way down, so every line of it counts
# as added. Kept distinct from a set of line numbers because "all of them" is
# not a number tq can know without reading the file.
EVERY_LINE = object()


def _git(args, cwd):
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    return proc.stdout if proc.returncode == 0 else None


def touched(base, cwd):
    """{absolute path: set of changed line numbers}, or None when there is no
    diff to scope against — not a repo, or no commit to compare with. None is
    the signal to report everything, never to report nothing."""
    root = _git(["rev-parse", "--show-toplevel"], cwd)
    if not root:
        return None
    root = root.strip()
    # --no-prefix, because the a/ and b/ a diff header usually carries are not
    # fixed: diff.mnemonicPrefix rewrites them per source (c/ for the commit,
    # w/ for the worktree), and stripping a hardcoded "b/" then leaves a path
    # that matches nothing — which scopes every finding away and reads as a
    # clean diff. quotePath=false stops a non-ASCII name arriving octal-escaped.
    out = _git(
        [
            "-c",
            "core.quotePath=false",
            "diff",
            "--unified=0",
            "--no-color",
            "--no-ext-diff",
            "--no-prefix",
            base,
            "--",
        ],
        cwd,
    )
    if out is None:
        return None

    changed, path, in_header = {}, None, False
    for line in out.splitlines():
        # Only the header block between `diff --git` and the first hunk can name
        # a file. An added line whose own content begins `++ ` arrives in the
        # body as `+++ `, and reading that as a header points the hunks that
        # follow at a path invented from the file's contents — which scopes the
        # real findings away and admits findings from a file that does not exist.
        if line.startswith("diff --git "):
            in_header, path = True, None
            continue
        if in_header and line.startswith("+++ "):
            target = line[4:].strip()
            # A deleted file has no new side, so nothing can be reported in it.
            if target == "/dev/null":
                path = None
                continue
            path = os.path.realpath(os.path.join(root, target))
            changed.setdefault(path, set())
            continue
        hunk = HUNK.match(line)
        if hunk:
            in_header = False
            if path is None:
                continue
            start = int(hunk.group("start"))
            # An absent count means one line; a count of 0 is a pure deletion,
            # which touches the file without adding a line to report on.
            count = 1 if hunk.group("count") is None else int(hunk.group("count"))
            changed[path].update(range(start, start + count))

    # A file the agent has just created is not in any diff against HEAD, so
    # every finding in the newest code in the tree scoped away as "not yours".
    # That is the wrong way round: it is the most yours of anything here.
    # --full-name and the :/ pathspec because ls-files otherwise answers about
    # the current directory's subtree, in paths relative to it — where the diff
    # above is repo-wide. Run from a subdirectory the two would not line up.
    untracked = _git(
        [
            "-c",
            "core.quotePath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
            "--full-name",
            "-z",
            "--",
            ":/",
        ],
        cwd,
    )
    for name in (untracked or "").split("\0"):
        if name:
            changed[os.path.realpath(os.path.join(root, name))] = EVERY_LINE
    return changed


def in_scope(fail, mode, changed, cwd):
    """Whether this finding belongs to the change being made.

    Anything that cannot be placed is kept. A finding with no file, or none
    with a line under `added`, has not been shown to be out of scope — and
    dropping it on that basis would be the silent loss tq exists to prevent.
    """
    if not fail.file:
        return True
    path = fail.file if os.path.isabs(fail.file) else os.path.join(cwd, fail.file)
    lines = changed.get(os.path.realpath(path))
    if lines is None:
        return False
    if mode == "file" or fail.line is None or lines is EVERY_LINE:
        return True
    return fail.line in lines


def apply_scope(result, mode, cwd, base="HEAD"):
    """Narrow `result.failures` to the diff. Returns how many were set aside.

    A no-op for anything but a linter, and for a result whose diff could not be
    read: both fall through reporting everything.
    """
    if mode == "all" or result.kind != "lint" or not result.failures:
        return 0
    changed = touched(base, cwd)
    if changed is None:
        return 0
    kept = [f for f in result.failures if in_scope(f, mode, changed, cwd)]
    dropped = len(result.failures) - len(kept)
    result.failures = kept
    return dropped
