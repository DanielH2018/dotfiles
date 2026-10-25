"""Scratch cleanup inside a session's own worktree: `rm` and `git clean` of untracked
files, `git restore`, and `git stash drop` of an entry made on the worktree's branch.

All three commands sit in the ask tier, because each destroys work no reflog brings back.
A headless session has no prompt to answer, so every cleanup it ran was refused: 41
denials across the fan-out batches of 2026-10-15..17 (dotfiles #861). These checks resolve
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
  - `rm` also refuses an operand, or a directory holding one, that a specific ignore rule
    names or whose name marks state or a secret (a dotenv file, a `.venv`, a SOPS file, a
    key). A root catch-all rule (`/*`, as the homelab repo has) ignores every new scratch
    file, so it does not count as a specific rule. `.fanout/`, the fan-out batches' own
    scratch directory, is exempt from the ignore rule and not from the name check.
  - `git restore` takes only `--staged`/`--worktree`/`--quiet` (bundled as `-SW` too) and
    a source of `HEAD`, and each operand must name exactly one file in the index or in
    HEAD. HEAD covers a file whose deletion the session staged, which `--staged --source=HEAD`
    brings back (dotfiles #987). A directory, `.` or a glob would discard more than the
    session edited, so none of them passes.
  - No operand carries a glob character, because the shell or git would expand it to paths
    no operand spells out.
  - A relative operand is refused once an earlier segment moved the shell's cwd, the same
    gate the heredoc-write carve-out in judge.py uses. A `cd` to the session worktree's
    root, followed only by `&&`, does not count as a move: judge.py judges the later
    segments in that root (dotfiles #987).

`git stash drop` is bounded differently, because the stash stack is shared by every
worktree of a repository: its one ref must name an entry whose subject carries the branch
the session worktree has checked out (dotfiles #1023). `worktree_stash_drop_safe` has the
details.

The git probes run a subprocess, as git_reset.py's do, and any failure of one is no opinion.
"""

import os
import re
from pathlib import PurePosixPath

from claude_guard.checks.git_reset import _git
from claude_guard.checks.scratch import BOOL_SHORT, LONG_OK, tokenize

_SESSION_WORKTREE = re.compile(r"/\.claude/worktrees/[^/]+$")
# Ignore rules that match every root entry: they cover scratch as well as state.
_CATCH_ALL = frozenset({"/*", "*", "/*/", "*/"})
# A name that marks state or a secret: a dotenv file, a virtualenv, a dependency tree, a
# SOPS file, a key, a credentials file. Whatever the repo's ignore rules say, `rm` leaves it.
_STATE_NAME = re.compile(
    r"^(\.venv|venv|node_modules|\.ssh|\.aws|\.gnupg|\.kube|secrets?)$"
    r"|^\.env(?!iron(?:ment|b)?$)|\.sops\.|credentials|\.(pem|key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)",
    re.IGNORECASE,
)
_WALK_LIMIT = 5000
_GLOB = re.compile(r"[*?\[\]{}\\]")
_RESTORE_FLAGS = frozenset({"--staged", "--worktree", "--quiet"})
_RESTORE_SHORT = frozenset("SWq")


def _worktree_root(cwd: str) -> str | None:
    """The git toplevel of `cwd` when it is a session worktree, else None."""
    if not cwd or not cwd.startswith("/"):
        return None
    out = _git(cwd, "rev-parse", "--show-toplevel")
    if out is None:
        return None
    root = os.path.realpath(out.strip())
    return root if _SESSION_WORKTREE.search(root) else None


def session_root(cwd: str, project_dir: str) -> str | None:
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
    root = session_root(cwd, project_dir)
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
    return all(_is_scratch(op, root) for op in operands)


def _is_scratch(real: str, root: str) -> bool:
    """True when nothing at or below `real` is named like state or ignored by a specific
    rule. A repo with a root catch-all (`/*`) ignores every new scratch file, so that rule
    alone says nothing; a rule that names the path does."""
    if PurePosixPath(real).relative_to(root).parts[0] == ".fanout":
        return not _names_state(real, root)
    if _names_state(real, root):
        return False
    listed = _git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--", real)
    if listed is None:
        return False
    paths = listed.splitlines()
    if not paths:
        return True
    if any(p.startswith('"') for p in paths):
        return False
    verbose = _git(root, "check-ignore", "-v", "--no-index", "--", *paths)
    if verbose is None:
        return False
    for line in verbose.splitlines():
        pattern = line.split("\t", 1)[0].split(":", 2)[-1]
        if pattern not in _CATCH_ALL:
            return False
    return True


def _names_state(real: str, root: str) -> bool:
    """True when `real`, or any path below it, has a name that marks state or a secret."""
    rel = PurePosixPath(real).relative_to(root).parts
    if any(_STATE_NAME.search(part) for part in rel):
        return True
    seen = 0
    for _dir, dirs, files in os.walk(real):
        for name in dirs + files:
            seen += 1
            if seen > _WALK_LIMIT or _STATE_NAME.search(name):
                return True
    return False


def _is_one_tracked_file(real: str, root: str) -> bool:
    """True when `real` is exactly one file in the index or in HEAD, which a directory
    never is. HEAD answers for a file whose deletion is staged."""
    rel = os.path.relpath(real, root)
    if _git(root, "ls-files", "--", rel) == rel + "\n":
        return True
    entry = _git(root, "ls-tree", "HEAD", "--", rel)
    # `<mode> blob <sha>\t<path>`: a tree or a submodule (`commit`) entry is not one file.
    return (
        entry is not None and re.fullmatch(rf"\d+ blob \w+\t{re.escape(rel)}\n", entry) is not None
    )


def worktree_restore_safe(part: str, cwd: str, cwd_changed: bool, project_dir: str) -> bool:
    """True when `part` is `git restore [--staged] [--worktree] [--source=HEAD] [--] paths`
    with every path one tracked file below the session worktree that holds both `cwd` and
    `project_dir`."""
    tokens = tokenize(part)
    if not tokens or tokens[:2] != ["git", "restore"]:
        return False
    root = session_root(cwd, project_dir)
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
        elif not endopts and tok.startswith("--"):
            if tok not in _RESTORE_FLAGS and tok != "--source=HEAD":
                return False
        elif not endopts and tok.startswith("-"):
            if len(tok) == 1 or any(ch not in _RESTORE_SHORT for ch in tok[1:]):
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


_CLEAN_SHORT = frozenset("fdqn")
_CLEAN_LONG = frozenset({"--force", "--quiet", "--dry-run"})


def worktree_clean_safe(part: str, cwd: str, cwd_changed: bool, project_dir: str) -> bool:
    """True when `part` is `git clean -f [-d] [-q] [--] paths` with every path untracked
    scratch below the session worktree that holds both `cwd` and `project_dir`, held to the
    same tests as `worktree_rm_safe` (dotfiles #864).

    A clean with no path cleans the whole tree, so at least one is required. `-x`, `-X`,
    `-e` and `-i` are refused: the first three reach ignored files, which is where state
    lives, and `-i` waits on a prompt. `-f` may appear once, because `-ff` also deletes a
    nested repository.
    """
    tokens = tokenize(part)
    if not tokens or tokens[:2] != ["git", "clean"]:
        return False
    root = session_root(cwd, project_dir)
    if root is None:
        return False
    operands: list[str] = []
    forces = 0
    endopts = False
    for tok in tokens[2:]:
        if not endopts and tok == "--":
            endopts = True
        elif not endopts and tok.startswith("--"):
            if tok not in _CLEAN_LONG:
                return False
            forces += tok == "--force"
        elif not endopts and tok.startswith("-") and len(tok) > 1:
            if any(ch not in _CLEAN_SHORT for ch in tok[1:]):
                return False
            forces += tok.count("f")
        elif tok.startswith(":"):
            return False
        else:
            real = _confined(tok, root, cwd, cwd_changed)
            if real is None:
                return False
            operands.append(real)
    if not operands or forces > 1:
        return False
    if _git(root, "ls-files", "--", *operands) != "":
        return False
    return all(_is_scratch(op, root) for op in operands)


_STASH_INDEX = re.compile(r"stash@\{\d+\}")
_STASH_SHA = re.compile(r"[0-9a-f]{7,40}")
# A whole unquoted `stash@{n}` word. bash and zsh both leave a brace holding one item
# unexpanded, so the word is literal, but `tokenize` refuses every unquoted brace.
_BARE_STASH_INDEX = re.compile(r"(?<![^ \t])(stash@\{\d+\})(?![^ \t])")


def worktree_stash_drop_safe(part: str, cwd: str, cwd_changed: bool, project_dir: str) -> bool:
    """True when `part` is `git stash drop [-q] <ref>` and `<ref>` names one stash entry
    created on the branch the session worktree holding `cwd` and `project_dir` has checked
    out (dotfiles #1023).

    The stash stack is shared by every worktree of a repository, so a drop can destroy
    another session's entry. git writes the branch into every stash subject (`On <branch>:`
    for `stash push -m`, `WIP on <branch>:` otherwise), and each session worktree is on its
    own branch, so the subject identifies the entry's owner. A branch name cannot hold `:`,
    so the prefix cannot match a longer branch name.

    `<ref>` is `stash@{n}` or a hex SHA that is a prefix of exactly one entry's commit. A
    drop with no ref drops `stash@{0}`, whoever owns it, and is refused, as is
    `git stash clear`, a detached HEAD, and any drop after an earlier segment moved the
    shell's cwd. The check and the drop are not atomic: a `stash push` by another session
    between them shifts every `stash@{n}` by one, which a SHA does not suffer.
    """
    tokens = tokenize(_BARE_STASH_INDEX.sub(r"'\1'", part))
    if not tokens or tokens[:3] != ["git", "stash", "drop"]:
        return False
    refs = [tok for tok in tokens[3:] if tok not in ("-q", "--quiet")]
    if len(refs) != 1 or not (_STASH_INDEX.fullmatch(refs[0]) or _STASH_SHA.fullmatch(refs[0])):
        return False
    if cwd_changed:
        return False
    root = session_root(cwd, project_dir)
    if root is None:
        return False
    head = _git(root, "symbolic-ref", "--quiet", "HEAD")
    if head is None or not head.startswith("refs/heads/"):
        return False
    branch = head.strip().removeprefix("refs/heads/")
    listing = _git(root, "stash", "list", "--format=%gd%x00%H%x00%s")
    if listing is None:
        return False
    ref = refs[0]
    subjects = []
    for line in listing.splitlines():
        fields = line.split("\0")
        if len(fields) == 3 and ref in (fields[0], fields[1][: len(ref)]):
            subjects.append(fields[2])
    return len(subjects) == 1 and subjects[0].startswith((f"On {branch}:", f"WIP on {branch}:"))
