"""The one resolver for the paths and index links a Claude memory store cites.

memory-upkeep.py (a SessionStart hook) and memory_survey.py (the memory-consolidation
skill's read-only survey) both ask whether a cited path exists and whether MEMORY.md
agrees with the files beside it. This module owns both questions, so the two callers
cannot disagree about a path one checkout holds and the default branch deleted.

Tree answers "does this repo path exist", judged by the default branch and not by one
checkout. index_state answers "do the index and the store agree", and asks Tree for
every repo path it meets.

Each caller puts lib/ beside the hooks on sys.path and imports this module from there.
That holds in the source tree and in ~/.claude, where chezmoi strips the mode prefix. A
single-file `chezmoi apply` of a caller without this module raises ImportError, so apply
the hooks directory as a whole.

Typical usage example:

  tree = Tree(repo, main_checkout(repo))
  state = index_state(memories, tree)
  if state.gone:
      ...
"""

from __future__ import annotations

import os
import re
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

# A markdown link to a memory file: `[label](file.md)`. The label may hold one level of
# brackets — "[A task tagged [config, deploy] is skipped …](…)" is a live entry, and a
# label pattern that stops at the first `]` never sees its marker.
INDEX_LINK = re.compile(r"\[(?:[^\[\]]|\[[^\]]*\])+\]\(([^)\s]+\.md)\)")

# The markers, as the index writes them: `[ENFORCED]`, `[ENFORCED, SCOPED]`, `(SCOPED)`.
# Read as independent substrings of the bracket or paren text, since the combined form
# is real.
INDEX_MARKER = re.compile(r"\[(ENFORCED[^\]]*)\]|\((SCOPED)\)")

# A pytest node id: a path, then one or more `::name` segments. PATHISH rejects the
# `::`, which is why node ids were invisible to the path scan. A parametrize suffix
# (`test_x[param]`) is dropped from the last segment.
NODE_ID = re.compile(r"^([\w.@+/-]+)((?:::[\w]+)+)(?:\[[^\]]*\])?$")


def _git(cwd: Path, *args: str) -> str | None:
    """A git command's stdout, or None when git fails or is missing."""
    try:
        result = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, check=False
        )
    except OSError:
        return None
    return result.stdout if result.returncode == 0 else None


def _with_parents(paths: Sequence[str]) -> set[str]:
    """`paths` and every directory above each one."""
    out: set[str] = set()
    for path in paths:
        while path and path not in out:
            out.add(path)
            path = path.rpartition("/")[0]
    return out


def main_checkout(repo: Path) -> Path:
    """The main checkout behind `repo`, which may be a linked worktree.

    Memory is keyed to the main checkout's path, so a session running in
    .claude/worktrees/<name> derives a slug no memory directory answers to and every
    section of the upkeep hook goes silent — in exactly the parallel worktree sessions
    where most work happens.

    `git rev-parse --git-common-dir` names the shared .git that every worktree of a repo
    points at; its parent is the main checkout. In the main checkout itself the answer
    is already that repo, so this costs one git call and changes nothing.

    It names the checkout for the memory slug, and `Tree` runs git there. `Tree`
    decides whether a path exists.

    Falls back to `repo` whenever the answer is unusable — git failing, an empty answer,
    a bare repo whose .git parent is not a checkout. A wrong slug is silence, which is
    the same failure as not looking at all, and never an error at session start.
    """
    result = subprocess.run(
        ["git", "rev-parse", "--git-common-dir"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    common = result.stdout.strip()
    if result.returncode != 0 or not common:
        return repo
    git_dir = Path(common)
    if not git_dir.is_absolute():
        # Git answers ".git" in the main checkout and may answer relatively elsewhere;
        # both are relative to the directory the command ran in.
        git_dir = repo / git_dir
    try:
        parent = git_dir.resolve().parent
    except OSError:
        return repo
    return parent if parent.is_dir() else repo


def sibling_checkouts(repo: Path, primary: Path) -> list[Path]:
    """Every other checkout of this repository: the main checkout and each linked
    worktree, minus `repo` itself.

    `Tree` reads them for a path the default branch does not track. The main checkout
    comes first. `primary` is included even when `git worktree list` fails, so a failed
    listing loses only the linked worktrees.
    """
    others: list[Path] = []
    if primary != repo:
        others.append(primary)
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return others
    if result.returncode != 0:
        return others
    for line in result.stdout.splitlines():
        if not line.startswith("worktree "):
            continue
        path = Path(line[len("worktree ") :])
        if path not in (repo, primary) and path not in others and path.is_dir():
            others.append(path)
    return others


class Tree:
    """What the repository holds, judged by its default branch and not by one checkout.

    A path is present when one of two things is true:

    1. The default branch tracks it.
    2. Some checkout holds it and the default branch never tracked it. That is a file on
       a branch that has not landed (dotfiles #557: a memory written ahead of its
       session's merge was flagged for a day), or an untracked path such as a gitignored
       directory. Measured on 2026-08-29: two of three flagged memories named
       `docs/superpowers/`, which is gitignored and lives only in the main checkout.

    A path the default branch once tracked and no longer does is gone, whichever
    checkouts still hold it. Before this rule any checkout holding the path counted. The
    homelab repo had 140 worktrees on 2026-11-13, and the hook reported none of the 10
    cited paths that master had deleted (dotfiles #1262).

    Whether git ignores the path does not enter into it. A deleted tree leaves ignored
    debris behind, such as `__pycache__`, and a rule that kept an ignored path present
    kept three deleted directories present on the one host whose main checkout held
    that debris.

    The default branch is `origin/HEAD`, or the main checkout's `HEAD` in a repo with no
    remote. A file's text comes from that branch too, so a test renamed on the default
    branch is missing even while a stale worktree still defines it. The cost is that a
    symbol added to a tracked file on an unlanded branch is missing until it lands.

    Outside a git repo, or before the first commit, nothing is tracked and rule 2 holds
    for every path a checkout has.
    """

    def __init__(self, repo: Path, primary: Path | None = None) -> None:
        self._repo = repo
        self._primary = primary or repo
        self._checkouts = [repo, *sibling_checkouts(repo, self._primary)]
        self._ref = None
        for ref in ("refs/remotes/origin/HEAD", "HEAD"):
            if _git(self._primary, "rev-parse", "--verify", "-q", ref + "^{commit}"):
                self._ref = ref
                break
        listed = self._ref and _git(
            self._primary, "ls-tree", "-r", "--name-only", self._ref
        )
        self._files = set((listed or "").splitlines())
        self._tracked = _with_parents(sorted(self._files))
        self._removed: set[str] | None = None

    @property
    def primary(self) -> Path:
        """The main checkout, where the default branch is read."""
        return self._primary

    def _once_tracked(self, path: str) -> bool:
        """Whether the default branch's history deleted or renamed away `path`.

        One walk of the whole history, made the first time it is needed: about half a
        second on 7,500 commits.
        """
        if self._removed is None:
            log = self._ref and _git(
                self._primary,
                "log",
                "--format=",
                "--name-only",
                "--diff-filter=D",
                "--no-renames",
                self._ref,
            )
            self._removed = _with_parents((log or "").split("\n"))
        return path in self._removed

    def has_top(self, name: str) -> bool:
        """Whether the repo has or had a top-level directory `name`."""
        return (
            name in self._tracked
            or (self._repo / name).is_dir()
            or self._once_tracked(name)
        )

    def holds(self, path: str) -> bool:
        """Whether `path`, a file or a directory, is present by the two rules."""
        path = path.rstrip("/")
        if path in self._tracked:
            return True
        if not any((c / path).exists() for c in self._checkouts):
            return False
        return not self._once_tracked(path)

    def read(self, path: str) -> str | None:
        """The text of the file at `path`, or None when no such file is present."""
        if path in self._files:
            return _git(self._primary, "show", f"{self._ref}:{path}")
        if not self.holds(path):
            return None
        for checkout in self._checkouts:
            try:
                return (checkout / path).read_text()
            except OSError:
                continue
        return None


def defines(text: str, symbol: str) -> bool:
    name = re.escape(symbol)
    pattern = rf"^\s*(?:async\s+def|def|class)\s+{name}\b|^\s*{name}\s*="
    return re.search(pattern, text, re.MULTILINE) is not None


def index_entries(index_text: str) -> list[tuple[str, bool]]:
    """(memory file name, scoped) for every index entry carrying a marker.

    Markers bind to the nearest PRECEDING link, not to the line: a bullet carries
    several links with a marker after each, and a line-level read either downgrades
    the first to the second's marker or hands an unmarked third one it never had.
    """
    entries = []
    for line in index_text.splitlines():
        links = list(INDEX_LINK.finditer(line))
        for i, link in enumerate(links):
            tail_end = links[i + 1].start() if i + 1 < len(links) else len(line)
            tail = line[link.end() : tail_end]
            enforced = scoped = False
            for m in INDEX_MARKER.finditer(tail):
                text = (m.group(1) or m.group(2)).upper()
                enforced |= "ENFORCED" in text
                scoped |= "SCOPED" in text
            if enforced or scoped:
                entries.append((link.group(1), scoped))
    return entries


def frontmatter_value(text: str, key: str) -> str | None:
    """The value of a `key: value` line in the leading `---` block, or None.

    Textual, so the stdlib is enough: a line that starts with the key, a colon and a
    value, between the opening `---` line and the next one. A `key:` line in the body,
    or in a file with no frontmatter, is not a value. Surrounding quotes are stripped.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    pattern = re.compile(rf"^{re.escape(key)}:[ \t]*(.*?)\s*$")
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        match = pattern.match(line)
        if match:
            value = match.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'`":
                value = value[1:-1]
            return value
    return None


@dataclass(frozen=True)
class IndexState:
    """Where MEMORY.md and the memory files beside it disagree.

    unindexed: memory files no index link names.
    gone: index link targets that do not exist.
    duplicated: one "<target>: linked N times" row per memory file the index links
        twice or more. A repo doc is exempt: one doc owns the claims of several retired
        memories, and each keeps its own index line.
    marker_mismatch: one row per way a memory's `enforced_by:` key and the index's
        `[ENFORCED]` marker disagree.
    """

    unindexed: list[str]
    gone: list[str]
    duplicated: list[str]
    marker_mismatch: list[str]


def _local_name(memories: Path, target: str) -> str | None:
    """The file name when a relative `target` names a file directly in `memories`."""
    if os.path.isabs(target):
        return None
    full = Path(os.path.normpath(memories / target))
    return full.name if full.parent == Path(os.path.normpath(memories)) else None


def _target_exists(memories: Path, target: str, tree: Tree) -> bool:
    if not os.path.isabs(target):
        return (memories / target).is_file()
    try:
        inside = Path(target).relative_to(tree.primary)
    except ValueError:
        return Path(target).is_file()
    return tree.holds(inside.as_posix())


def _node_resolves(node: str, tree: Tree) -> bool:
    match = NODE_ID.match(node)
    if not match:
        return False
    text = tree.read(match.group(1))
    if text is None:
        return False
    return all(defines(text, name) for name in match.group(2).split("::")[1:])


def index_state(memories: Path, tree: Tree) -> IndexState:
    """Compare MEMORY.md with the memory files in `memories`.

    A relative link target resolves against `memories`. An absolute target under the
    main checkout is a repo path, so `tree` judges it by the default branch. Any other
    absolute target is a plain file.

    A memory whose frontmatter has an `enforced_by:` key owes the index an `[ENFORCED]`
    marker and a node id that resolves. A marked entry with no such key is not a
    mismatch: stale-check resolution reads its check from the entry's prose.

    A missing or unreadable MEMORY.md gives an empty state.
    """
    empty = IndexState([], [], [], [])
    try:
        index_text = (memories / "MEMORY.md").read_text()
    except OSError:
        return empty

    counts: dict[str, int] = {}
    for target in INDEX_LINK.findall(index_text):
        key = target if os.path.isabs(target) else os.path.normpath(target)
        counts[key] = counts.get(key, 0) + 1

    linked = {name for t in counts if (name := _local_name(memories, t))}
    marked = {
        name for t, _ in index_entries(index_text) if (name := _local_name(memories, t))
    }
    files = sorted(
        p for p in memories.glob("*.md") if p.is_file() and p.name != "MEMORY.md"
    )

    mismatch: list[str] = []
    for path in files:
        try:
            node = frontmatter_value(path.read_text(errors="replace"), "enforced_by")
        except OSError:
            continue
        if node is None:
            continue
        if path.name not in marked:
            mismatch.append(f"{path.name}: has enforced_by and no [ENFORCED] marker")
        if not _node_resolves(node, tree):
            mismatch.append(
                f"{path.name}: enforced_by names {node}, which does not resolve"
            )

    return IndexState(
        unindexed=[p.name for p in files if p.name not in linked],
        gone=[t for t in counts if not _target_exists(memories, t, tree)],
        duplicated=[
            f"{t}: linked {n} times"
            for t, n in counts.items()
            if n > 1 and not os.path.isabs(t)
        ],
        marker_mismatch=mismatch,
    )
