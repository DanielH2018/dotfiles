"""`git reset --hard origin/master`/`origin/main`, onto a provably clean tree.
allow-clean-reset.sh ported.

`git reset --hard` sits in the ask list because it takes an arbitrary ref and discards both
uncommitted edits and local commits with no undo the way `rm` has none. But the homelab
landing procedure runs this exact command against a CLEAN worktree to fast-forward local
state onto origin before a follow-up commit, and on a clean tree the only thing discarded is
local commits, which stay in the reflog (:10-17).

Deliberately narrow, same posture as allow-safe-rm.sh's option table: the ref must be the
literal `origin/master` or `origin/main`, never a SHA, an `@{...}` reflog expression, or a
pathspec after `--` (:19-23).

Unlike every sibling check in this package, the cleanliness probe below RUNS git: a real
subprocess with a real failure mode. A non-zero exit, a timeout, or a failure to run git at
all (missing binary, no repo at `cwd`) are all "no opinion", never "allow" — the same posture
as every other fall-through here, just reached through a subprocess instead of a parse.
"""

import os
import re
import subprocess

from claude_guard.segment import parse

# Bounds the two git probes below; a hang on a wedged filesystem must not hold the
# PermissionRequest hook open indefinitely. Not cited to the bash: the shell hook has no
# equivalent, since a stuck `git` there would simply hang the hook the same way.
_GIT_TIMEOUT = 5.0

# :72. Strips a trailing `2>&1` before matching — it redirects where stderr goes, not what
# the command does, and the real invocations almost always carry it ahead of the pipe.
_STRIP_2_1 = re.compile(r"[ \t]+2>&1[ \t]*$")

# :77. Exactly `git reset --hard [-q|--quiet] <ref> [-q|--quiet]` — the quiet flag may sit
# on either side of the ref (both real orderings seen in practice), but only once.
_RESET_RE = re.compile(
    r"^git[ \t]+reset[ \t]+--hard([ \t]+(-q|--quiet))?"
    r"[ \t]+(origin/master|origin/main)([ \t]+(-q|--quiet))?$"
)

# :88. The only tolerated second segment: nothing but `tail -n N` / `tail -N`.
_TAIL_RE = re.compile(r"^tail[ \t]+(-n[ \t]*[0-9]+|-[0-9]+)$")

# :100. A rebase/merge/cherry-pick in progress is refused even on a clean tree, because
# `reset --hard` there abandons the operation's state, which `git status --porcelain` does
# not show.
_MARKERS = ("rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD")


def _git(cwd: str, *args: str) -> str | None:
    """Run `git -C cwd <args>`. None on any failure: non-zero exit, a timeout, or a failure
    to launch git at all (missing binary, unreadable cwd) — never a raised exception."""
    try:
        proc = subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            text=True,
            timeout=_GIT_TIMEOUT,
        )
    except OSError, subprocess.TimeoutExpired:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def clean_reset_safe(command: str, cwd: str) -> bool:
    """:61-107. True only when `command` is `git reset --hard origin/master`/`origin/main`
    (optionally `-q`/`--quiet` and a trailing `2>&1`, optionally piped into `tail`), with no
    substitution anywhere, run against a `cwd` that is a git worktree, outside a
    rebase/merge/cherry-pick, with an empty `git status --porcelain --untracked-files=no`.

    False is "no opinion" everywhere else — a parse refusal, a shape that doesn't match, a
    substitution, an in-progress rebase/merge/cherry-pick, a dirty tree, or any failure of
    the git probes themselves (:96-97, :104), the same fall-through as the bash's
    unconditional `exit 0`.

    Fix round 1, F1: a falsy or non-absolute `cwd` is refused here, before anything else
    runs. `git -C ""` is a documented no-op — it silently probes the HOOK PROCESS's own
    cwd, not the session's, and `"" + "/" + ".git"` (below) can never find a
    MERGE_HEAD/CHERRY_PICK_HEAD marker, disabling the rebase/merge/cherry-pick guard
    outright. DECIDED: unlike allow-clean-reset.sh:46-47 (`CWD=$(hook_field '.cwd //
    ""'); [[ -z $CWD ]] && CWD=$PWD`), this does NOT fall back to the process's own cwd —
    fail-closed is the right posture for a security gate's fall-through, even diverging
    from the bash it ports.
    """
    if not cwd or not cwd.startswith("/"):
        return False
    if not command:
        return False

    # :61-62. A parse refusal is a refusal, never a skip.
    parsed = parse(command)
    if not parsed.ok:
        return False

    # :66. One command, or one piped through a trailing `tail` — nothing else.
    nseg = len(parsed.segments)
    if nseg not in (1, 2):
        return False

    seg0 = parsed.segments[0]
    # :67. Checked before the shape is even known, same order as the bash.
    if seg0.heredocs:
        return False

    text0 = _STRIP_2_1.sub("", seg0.text.strip()).strip()
    if not _RESET_RE.match(text0):
        return False

    if nseg == 2:
        # :81-88. The separator that TERMINATED segment 0 must be a single `|`, not `||`.
        if seg0.sep != "|":
            return False
        seg1 = parsed.segments[1]
        if seg1.heredocs:
            return False
        if not _TAIL_RE.match(seg1.text.strip()):
            return False

    # :91-94. A `$(...)` or backtick could smuggle a different ref or a second command in
    # through the ref position or the redirect, regardless of where it sits textually.
    if parsed.substitutions:
        return False

    # :96-98. An unreadable/non-repo cwd, a missing git binary, or a timeout are all "no
    # opinion" here, folded into `_git` returning None.
    gitdir = _git(cwd, "rev-parse", "--git-dir")
    if gitdir is None:
        return False
    gitdir = gitdir.strip()
    if not gitdir:
        return False
    if not gitdir.startswith("/"):
        gitdir = f"{cwd.rstrip('/')}/{gitdir}"

    for marker in _MARKERS:
        if os.path.exists(os.path.join(gitdir, marker)):
            return False

    # :104. A non-zero exit (unreadable tree) is "no opinion", same as everywhere else.
    status = _git(cwd, "status", "--porcelain", "--untracked-files=no")
    if status is None:
        return False
    return status.strip() == ""
