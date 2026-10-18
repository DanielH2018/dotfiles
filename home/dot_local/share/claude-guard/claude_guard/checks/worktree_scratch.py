"""Scratch cleanup inside a session's own worktree: `rm` of untracked files, `git restore`.

Both commands sit in the ask tier, because each destroys work no reflog brings back. A
headless session has no prompt to answer, so every cleanup it ran was refused: 41 denials
across the fan-out batches of 2026-10-15..17 (dotfiles #861). These two checks resolve
that ask for the one place a session owns outright, a worktree under `.claude/worktrees/`.

What bounds them:

  - The cwd's git toplevel must be `<repo>/.claude/worktrees/<name>`, and the session's
    project dir (CLAUDE_PROJECT_DIR, passed in as `project_dir`) must sit in that same
    worktree. A session that moved into a sibling's worktree, a primary checkout, or any
    other directory gets no opinion.
  - Every operand resolves (realpath, so a symlink is followed) strictly below that
    toplevel, and never into its `.git` file.
  - `rm` refuses any operand git tracks, so it only deletes untracked files. A tracked file
    goes through `git rm`, which the index records.
  - `rm` also refuses a gitignored operand, or a directory holding one: an ignored path is
    usually state the session did not make (a dotenv file, a `.venv`, a build cache).
    Untracked and not ignored is what a session creates and forgets. The one ignored
    subtree it may remove is `.fanout/`, the fan-out batches' own scratch directory.
  - `git restore` takes only `--staged`/`--worktree`/`--quiet` and a source of `HEAD`, and
    each operand must name exactly one tracked file. A directory, `.` or a glob would
    discard more than the session edited, so none of them passes.
  - No operand carries a glob character, because the shell or git would expand it to paths
    no operand spells out.
  - A relative operand is refused once an earlier segment moved the shell's cwd, the same
    gate the heredoc-write carve-out in judge.py uses.

The git probes run a subprocess, as git_reset.py's do, and any failure of one is no opinion.
"""

import os
import re
from pathlib import PurePosixPath

from claude_guard.checks.git_reset import _git
from claude_guard.checks.scratch import BOOL_SHORT, LONG_OK, tokenize

_SESSION_WORKTREE = re.compile(r"/\.claude/worktrees/[^/]+$")
_GLOB = re.compile(r"[*?\[\]{}\\]")
_RESTORE_FLAGS = frozenset({"--staged", "-S", "--worktree", "-W", "-q", "--quiet"})


def _worktree_root(cwd: str) -> str | None:
    """The git toplevel of `cwd` when it is a session worktree, else None."""
    if not cwd or not cwd.startswith("/"):
        return None
    out = _git(cwd, "rev-parse", "--show-toplevel")
    if out is None:
        return None
    root = os.path.realpath(out.strip())
    return root if _SESSION_WORKTREE.search(root) else None


def _session_root(cwd: str, project_dir: str) -> str | None:
    """The worktree root `cwd` sits in, when `project_dir` sits in the same one."""
    root = _worktree_root(cwd)
    if root is None or not project_dir:
        return None
    return root if _worktree_root(project_dir) == root else None


def _confined(path: str, root: str, cwd: str, cwd_changed: bool) -> str | None:
    """The resolved operand when it sits strictly below `root` and outside `.git`."""
    if not path or path.startswith("-") or _GLOB.search(path):
        return None
    if not path.startswith("/") and cwd_changed:
        return None
    real = os.path.realpath(os.path.join(cwd, path))
    if not real.startswith(root + "/"):
        return None
    if ".git" in PurePosixPath(real).relative_to(root).parts:
        return None
    return real


def worktree_rm_safe(part: str, cwd: str, cwd_changed: bool, project_dir: str) -> bool:
    """True when `part` is an `rm` whose every operand is an untracked path below the
    session worktree that holds both `cwd` and `project_dir`. Options are scratch.py's
    table."""
    tokens = tokenize(part)
    if not tokens or tokens[0].rsplit("/", 1)[-1] != "rm":
        return False
    root = _session_root(cwd, project_dir)
    if root is None:
        return False
    operands: list[str] = []
    endopts = False
    for tok in tokens[1:]:
        if not endopts and tok == "--":
            endopts = True
        elif not endopts and tok.startswith("--"):
            if tok not in LONG_OK:
                return False
        elif not endopts and tok.startswith("-") and len(tok) > 1:
            if any(ch not in BOOL_SHORT for ch in tok[1:]):
                return False
        else:
            real = _confined(tok, root, cwd, cwd_changed)
            if real is None:
                return False
            operands.append(real)
    if not operands:
        return False
    if _git(root, "ls-files", "--", *operands) != "":
        return False
    # `.fanout/` is ignored by design, so the ignore probe skips it.
    probed = [op for op in operands if PurePosixPath(op).relative_to(root).parts[0] != ".fanout"]
    if not probed:
        return True
    status = _git(root, "status", "--porcelain", "--ignored", "--", *probed)
    return status is not None and not any(line.startswith("!!") for line in status.splitlines())


def _is_one_tracked_file(real: str, root: str) -> bool:
    """True when `real` is exactly one path in the index, which a directory never is."""
    rel = os.path.relpath(real, root)
    return _git(root, "ls-files", "--", rel) == rel + "\n"


def worktree_restore_safe(part: str, cwd: str, cwd_changed: bool, project_dir: str) -> bool:
    """True when `part` is `git restore [--staged] [--worktree] [--source=HEAD] [--] paths`
    with every path one tracked file below the session worktree that holds both `cwd` and
    `project_dir`."""
    tokens = tokenize(part)
    if not tokens or tokens[:2] != ["git", "restore"]:
        return False
    root = _session_root(cwd, project_dir)
    if root is None:
        return False
    paths = 0
    endopts = False
    rest = tokens[2:]
    while rest:
        tok = rest.pop(0)
        if not endopts and tok == "--":
            endopts = True
        elif not endopts and tok in ("-s", "--source"):
            if not rest or rest.pop(0) != "HEAD":
                return False
        elif not endopts and tok.startswith("-"):
            if tok not in _RESTORE_FLAGS and tok != "--source=HEAD":
                return False
        elif tok.startswith(":"):
            # `:(…)` is pathspec magic, which can name paths no operand spells out.
            return False
        else:
            real = _confined(tok, root, cwd, cwd_changed)
            if real is None or not _is_one_tracked_file(real, root):
                return False
            paths += 1
    return paths > 0
