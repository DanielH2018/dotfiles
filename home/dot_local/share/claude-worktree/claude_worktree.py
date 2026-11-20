"""What a Claude session worktree is, and whether it is done with.

`claude_worktree_sweep.py` beside this file is the pruner: it sweeps every worktree
under a repository's `.claude/worktrees/`. This module holds what judges or removes ONE
tree, so a caller with a single tree in hand imports it without importing the sweep. The
server repo's `lib.worktrees` does that for `findings.py` and `fanout.py`.

Four parts, in file order:

- The readers: the `Worktree` record, the porcelain parser, the lock-liveness check, the
  cherry and merge-tree verdicts, the forge lookup and the /proc scan. Each takes text
  and returns a verdict, or runs one read-only query.
- The landed ladder: `local_layer` and `merged_layer` name the layer that found a
  branch's work on its base (`ancestry`, `patch-id`, `content` or `forge`), through the
  verdict cache in the git common dir.
- The holds: a live lock (`lock_is_live`), a live process (`processes_using`), a branch
  that has not moved since it was created (`is_fresh`) and uncommitted work
  (`is_dirty`).
- `classify` and `remove`, which turn those into a verdict and act on it.

Every unknown reads in the KEEP direction, because every caller acts on these answers by
deleting: a git call that fails is not landed, an unreadable tree is dirty, and a lock
in a format nobody recognises is live.

A caller reaches the deployed copy at `~/.local/share/claude-worktree`
(`CLAUDE_WORKTREE_HOME` overrides the path), the way `claude_guard` is reached from
`~/.local/share/claude-guard`. `INTERFACE` is how such a caller refuses a stale copy.

Python 3.10 is the floor, not 3.14: the SessionStart hook falls back to the system
interpreter, so nothing here may use syntax the system python3 lacks.
"""

import contextlib
import functools
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# Raised by one whenever a caller outside this repo needs something an older copy
# lacks. Such a caller compares it against the number it was written for, so a host
# whose `chezmoi apply` is behind fails loudly instead of running the older rules.
INTERFACE = 2

LOCK_OWNER = re.compile(r"\(pid (\d+) start (\d+)\)")


@dataclass
class Worktree:
    """One entry from `git worktree list --porcelain`.

    Attributes:
        branch: the checked-out branch, or None when the worktree is detached.
        lock_reason: the reason text `git worktree lock` recorded, empty when unlocked.
    """

    path: str
    head: str
    branch: str | None
    locked: bool
    lock_reason: str = ""


def parse_worktree_list(porcelain: str) -> list[Worktree]:
    """Parse `git worktree list --porcelain` into records, primary checkout first."""
    trees: list[Worktree] = []
    path = head = branch = None
    locked, reason = False, ""
    for line in porcelain.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree ") :]
            head, branch, locked = None, None, False
        elif line.startswith("HEAD "):
            head = line[len("HEAD ") :]
        elif line.startswith("branch "):
            branch = line[len("branch ") :].removeprefix("refs/heads/")
        elif line == "locked" or line.startswith("locked "):
            locked = True
            reason = line[len("locked ") :] if line.startswith("locked ") else ""
        elif line == "" and path is not None:
            trees.append(Worktree(path, head or "", branch, locked, reason))
            path = head = branch = None
            locked, reason = False, ""
    if path is not None:
        trees.append(Worktree(path, head or "", branch, locked, reason))
    return trees


def session_is_alive(lock_reason: str) -> bool:
    """Is the process named in a worktree's lock reason still running?

    The reason Claude Code writes carries the owning pid and its start time, e.g.
    `claude session foo (pid 1285937 start 2164388)`. Comparing the start time against
    /proc/<pid>/stat rejects a pid that has been reused since the session died. A reason
    in any other format is treated as live: an unrecognized lock is someone else's, and
    guessing wrong destroys work.
    """
    match = LOCK_OWNER.search(lock_reason)
    if not match:
        return True
    pid, start = match.group(1), match.group(2)
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    # The comm field can itself contain spaces and parentheses, so field numbering is
    # only reliable after the final ')'. starttime is field 22, the 20th of those after.
    fields = stat.rpartition(")")[2].split()
    return len(fields) > 19 and fields[19] == start


def cherry_says_landed(cherry_output: str, *, empty_means: bool) -> bool:
    """Read `git cherry <target> <head>`: True when every commit is on the target.

    One line per commit on `head`, prefixed `-` when a patch-identical commit is already
    on the target and `+` when none is. Any `+` line is a commit the target lacks.

    `empty_means` is the verdict for output with no lines at all, and the caller MUST
    choose it, because the two callers need opposite answers. The server pruner gates on
    the command's exit status first, so for it an empty listing means nothing is ahead
    of upstream — merged. The dotfiles hook has no such gate and reads emptiness as no
    evidence, because a freshly created worktree with no commits of its own also lists
    nothing, and calling that "landed" would report every new worktree.
    """
    lines = [line for line in cherry_output.splitlines() if line.strip()]
    if not lines:
        return empty_means
    return all(line.startswith("-") for line in lines)


def merge_tree_says_contained(merge_tree_stdout: str, target_tree: str) -> bool:
    """Read `git merge-tree --write-tree <target> <head>`: True on a no-op merge.

    The command prints the OID of the tree merging the branch would produce. When that
    equals the target's own tree, the branch has nothing the target does not already
    hold — which is what a squash merge leaves behind, and what neither ancestry nor
    patch-id can see, because a squash keeps the content while discarding the commits
    that carried it.

    Empty input is a failure to read a verdict, not a match, so it returns False — both
    arguments must be present for a comparison to mean anything.
    """
    lines = [line.strip() for line in merge_tree_stdout.splitlines() if line.strip()]
    target = target_tree.strip()
    if not lines or not target:
        return False
    return lines[0] == target


def git_env() -> dict[str, str]:
    """The process environment minus every `GIT_*` variable.

    git exports `GIT_DIR` and `GIT_WORK_TREE` to every hook it runs, and both outrank
    `cwd` and `-C`. Unscrubbed, a sweep started from a git hook would read and remove
    worktrees of the repository the hook fired in, whatever directory it was given.
    """
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


def git(
    *args: str, cwd: str | Path | None = None, stdin: str | None = None
) -> subprocess.CompletedProcess:
    """Run `git <args>` in `cwd`, which alone picks the repo; never raises on exit.

    A `cwd` that does not exist reads as a failed call (exit 128), so a caller that
    tests `returncode` handles a vanished tree like any other git failure.
    """
    try:
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=git_env(),
            capture_output=True,
            text=True,
            check=False,
            input=stdin,
        )
    except OSError as exc:
        return subprocess.CompletedProcess(["git", *args], 128, "", str(exc))


def _git_stdout(args: list[str], cwd: str | Path | None = None) -> str:
    return git(*args, cwd=cwd).stdout.strip()


def default_ref(repo: str) -> str | None:
    """The remote's default branch ref, or None when there is no merge target at all.

    `origin/HEAD` is what the remote itself says, so it survives a repo whose default is
    neither main nor master. It is only a local symref and can be missing on a clone
    made with --single-branch, hence the two guesses behind it. Returning None keeps
    every tree: without a merge target, nothing can be shown to have landed.
    """
    head = _git_stdout(
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd=repo
    )
    if head:
        return head
    for guess in ("origin/main", "origin/master"):
        if _git_stdout(["rev-parse", "--verify", "--quiet", guess], cwd=repo):
            return guess
    return None


def pr_head_says_merged(stdout: str, head: str) -> bool:
    """Read `gh pr list --state merged --head <branch> --json headRefOid`.

    True when one of those merged PRs was merged from exactly this commit.

    Matching on the head SHA, never on "a merged PR exists for this branch name".
    Branch names are reused: on 2026-08-27 one session in DanielH2018/server landed
    three PRs from `worktree-pi-detached-container-arm`, each with a different tip, so
    a name match would delete a branch carrying work that never landed. SHA equality is
    the whole guarantee.
    """
    try:
        prs = json.loads(stdout or "[]")
    except json.JSONDecodeError:
        return False
    if not isinstance(prs, list):
        return False
    return any(isinstance(p, dict) and p.get("headRefOid") == head for p in prs)


# One answer per (repo, branch, head) for the life of the process. A fan-out asks the
# same question once per claimed issue, and each ask is a network round-trip (server
# #1279).
_FORGE_MEMO: dict[tuple[str, str, str], bool] = {}


def forge_says_merged(repo: str, branch: str, head: str, timeout: float = 10.0) -> bool:
    """Did GitHub merge a PR whose head was exactly `head`, from branch `branch`?

    This is the one signal that settles a squash merge after the default branch drifted
    into a conflict with it: ancestry, patch-id and merge-tree all fail there, and only
    the forge still knows what it merged. It is also the only reader here that needs the
    network and credentials, so callers ask it last.

    Every failure is no verdict and reads False: no `gh`, no auth, a timeout, or output
    that does not parse. Both callers act on True by deleting, so unknown must keep.
    `--limit 30`: with a reused branch name, the PR whose head is this tip need not be
    the newest one. `GH_BIN` overrides the executable, which is how tests stub it.
    """
    if not branch or not head:
        return False
    key = (repo, branch, head)
    if key in _FORGE_MEMO:
        return _FORGE_MEMO[key]
    argv = [
        os.environ.get("GH_BIN", "gh"),
        "pr",
        "list",
        "--state",
        "merged",
        "--head",
        branch,
        "--limit",
        "30",
        "--json",
        "headRefOid",
    ]
    env = dict(os.environ, GH_PROMPT_DISABLED="1", GH_NO_UPDATE_NOTIFIER="1")
    try:
        result = subprocess.run(
            argv,
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        verdict = False
    else:
        verdict = result.returncode == 0 and pr_head_says_merged(result.stdout, head)
    _FORGE_MEMO[key] = verdict
    return verdict


# The `how` of a hold whose path is unknown. Such a process holds every tree; see
# `_foreign_in_my_slice`.
FOREIGN_UID = "uid, another one inside this uid's login slice (unreadable)"


def process_holds(
    proc: str = "/proc", uid: int | None = None
) -> list[tuple[int, str, str]]:
    """(pid, path, how) for each directory a live process holds.

    A process holds two paths: its cwd, and the `CLAUDE_PROJECT_DIR` in its
    environment. The second is the one a cwd scan misses. A Claude session whose
    project dir is a worktree loses every repo hook once that tree is deleted, and the
    session's cwd can be elsewhere by then (server#3887). The variable is read from
    every process, not only `claude` ones: the binary's command name is its version
    string, so a name match finds nothing, and each hook or tool shell a session spawns
    carries the variable too.

    Another user's process has no readable cwd link or environment. It is skipped,
    except when `_foreign_in_my_slice` counts it; that hold has an empty path and
    `how` FOREIGN_UID, and `holds_tree` matches it against every tree. A process that
    exits mid-scan is skipped, and so is the scanning process itself. Off Linux there
    is no /proc and the list is empty. The kernel appends " (deleted)" to a cwd whose
    directory is gone; it is stripped so a process standing in a half-removed tree
    still counts.

    `processes_using` is the caller that gates a removal: it asks the root helper
    first, where a host has one, and falls back to this scan.

    Args:
        proc: the procfs root to scan.
        uid: the uid whose login slice the foreign-uid rule looks in; this process's
            uid when None.

    Returns:
        One entry per held path; `how` is "cwd", "CLAUDE_PROJECT_DIR" or FOREIGN_UID.
    """
    if uid is None:
        uid = os.getuid() if hasattr(os, "getuid") else -1  # no uid on Windows
    me = os.getpid()
    out = []
    try:
        entries = os.listdir(proc)
    except OSError:
        return out
    for name in entries:
        if not name.isdigit() or int(name) == me:
            continue
        pid = int(name)
        entry = Path(proc, name)
        try:
            cwd = os.readlink(entry / "cwd")
            out.append((pid, cwd.removesuffix(" (deleted)"), "cwd"))
        except OSError:
            pass
        try:
            environ = (entry / "environ").read_bytes()
        except OSError:
            if _foreign_in_my_slice(entry, uid):
                out.append((pid, "", FOREIGN_UID))
            continue
        for var in environ.split(b"\0"):
            if var.startswith(b"CLAUDE_PROJECT_DIR="):
                held = var.partition(b"=")[2].decode(errors="replace")
                if held:
                    # Unlike a cwd link, the variable is whatever string was exported.
                    out.append((pid, os.path.realpath(held), "CLAUDE_PROJECT_DIR"))
                break
    return out


def _foreign_in_my_slice(entry: Path, uid: int) -> bool:
    """Whether an unreadable process runs as another non-root uid inside `uid`'s slice.

    `status` and `cgroup` stay world-readable when `cwd` and `environ` do not, so this
    reads only those two.
    """
    # DECIDED: count an unreadable process only when another non-root uid runs it
    # inside `user-<this uid>.slice`; every wider rule refuses every removal on a host
    # that runs agents as a second user.
    # The kernel checks search permission when a path is resolved, not on a cwd a
    # process inherits, so `sudo -u claude` run from inside a worktree leaves a process
    # holding a cwd this uid cannot read. sudo's PAM stack carries no pam_systemd, so
    # that process stays in the caller's slice. Any wider rule keeps every tree: root's
    # daemons, another user's own sessions and this uid's non-dumpable agents are
    # always alive and always unreadable. A launch that opens a new logind session
    # (`su`, `machinectl shell`) or a unit (`systemd-run --uid`) lands in the target's
    # slice and is not seen.
    try:
        status = (entry / "status").read_text()
        cgroup = (entry / "cgroup").read_text()
    except OSError:
        return False
    uid_line = next(
        (line for line in status.splitlines() if line.startswith("Uid:")), ""
    )
    fields = uid_line.split()
    if len(fields) < 3 or int(fields[2]) in (0, uid):
        return False
    return f"/user.slice/user-{uid}.slice/" in cgroup


def holds_tree(held: str, roots: set[str]) -> bool:
    """Whether a hold from `process_holds` is one of `roots` or below one.

    An empty `held` is a FOREIGN_UID hold, whose path is unknown, so it holds every
    tree. A sibling that only shares a prefix, `/w/ab` against `/w/a`, does not match.
    """
    if not held:
        return True
    return any(held == r or held.startswith(r + "/") for r in roots)


def tree_roots(path: str) -> set[str]:
    """`path` as given and resolved, the two forms a hold is compared against.

    git reports a worktree's path as it was created, and /proc reports the real one.
    """
    return {path.rstrip("/"), str(Path(path).resolve())}


def primary_checkout(start: str | None = None) -> str | None:
    """The checkout the worktrees hang off, or None when there is no checkout to name.

    Not the current one: worktrees live under the primary's `.claude/worktrees/`, and
    `--show-toplevel` run from inside a worktree returns the worktree itself.

    The primary is the parent of the common git dir only when that dir is named
    `.git`. A separated git dir or a bare repo has no checkout beside it, so either
    answers None.

    Args:
        start: the directory to ask from; the process cwd when None.
    """
    common_dir = _git_stdout(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=start
    )
    if not common_dir or Path(common_dir).name != ".git":
        return None
    return str(Path(common_dir).parent)


# --- the landed ladder -------------------------------------------------------------
#
# "Landed" is judged four ways, cheapest first. Ancestry settles a fast-forward or a
# merge commit. `git cherry` compares by patch-id and settles a rebase, which replays
# the commits as new objects. `git merge-tree` settles a squash, which leaves no
# patch-id to match, by asking whether merging the branch would change the base at all.
# The forge settles a squash the base has since drifted into a conflict with, where
# merge-tree has no verdict: it still knows which head it merged.
#
# The layers are not equal evidence. Ancestry is proof, and so is the forge, which
# matches on the head SHA. A patch-id match is also what a cherry-picked hotfix or a
# revert of a revert looks like, and a content match is also what a branch superseded
# by later work looks like. `classify` therefore takes the set of layers a caller lets
# act, and reports the others for review.

# The merged verdict, kept on disk across processes, in the git common dir so it is
# never in a working tree. Keyed by "<head sha>:<base sha>". The three local layers are
# pure functions of those two commits, so a recorded answer cannot go stale: a moved
# base or a new commit is a new key. A value is the layer that said landed, or "" when
# the local layers settled "no". The forge's "merged" holds for a head forever and is
# written over any other value.
#
# The forge's "not merged" can change, so it is kept under its own
# "forge-no:<head sha>:<branch>" key with the epoch second it was asked, and trusted
# for FORGE_NO_TTL_S only. A stale "no" can only keep a tree a little longer.
VERDICT_CACHE = "claude-merged-verdicts.json"
# Newest kept. A key a moved base has orphaned is never asked again, so age is the
# right thing to drop by.
VERDICT_CACHE_CAP = 4000
LOCAL_LAYERS = ("ancestry", "patch-id", "content")
FORGE = "forge"
# Long enough to span reading a report and running the prune; short enough that a PR
# merged since is seen at the next session start.
FORGE_NO_TTL_S = 15 * 60
_FORGE_NO = "forge-no:"


@functools.cache
def verdict_cache_path(repo: str) -> Path | None:
    """The cache file in `repo`'s git common dir, or None when git cannot name it."""
    common = _git_stdout(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=repo
    )
    return Path(common) / VERDICT_CACHE if common else None


def verdict_key(repo: str, head: str, base: str) -> str | None:
    """`<head sha>:<base sha>`, or None when either does not resolve."""
    if not head or not base:
        return None
    result = git("rev-parse", f"{head}^{{commit}}", f"{base}^{{commit}}", cwd=repo)
    shas = result.stdout.split()
    if result.returncode != 0 or len(shas) != 2:
        return None
    return f"{shas[0]}:{shas[1]}"


def read_verdicts(repo: str) -> dict[str, str]:
    """The recorded verdicts; an empty dict when the file is missing or unreadable."""
    path = verdict_cache_path(repo)
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _write_verdicts(path: Path, verdicts: dict[str, str]) -> None:
    """Replace the cache file by rename, so a reader never sees half of one."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps(verdicts))
        os.replace(tmp, path)
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()


def record_verdict(repo: str, key: str, layer: str) -> None:
    """Add one verdict to the cache file, best-effort.

    Re-reads before writing, so a concurrent session's entries survive. Two writers
    racing can drop one entry, which costs only a recomputation, and a failed write is
    ignored for the same reason.
    """
    path = verdict_cache_path(repo)
    if path is None:
        return
    verdicts = read_verdicts(repo)
    verdicts.pop(key, None)
    verdicts[key] = layer
    _write_verdicts(path, dict(list(verdicts.items())[-VERDICT_CACHE_CAP:]))


def drop_dead_verdicts(repo: str, live_heads: set[str]) -> None:
    """Drop every verdict whose head is not in `live_heads`.

    A sweep calls this once with every branch tip and worktree HEAD, so a deleted
    branch's verdicts go with it instead of waiting for the cap.
    """
    path = verdict_cache_path(repo)
    if path is None:
        return
    verdicts = read_verdicts(repo)

    def head(key: str) -> str:
        return key.split(":")[1 if key.startswith(_FORGE_NO) else 0]

    kept = {k: v for k, v in verdicts.items() if head(k) in live_heads}
    if len(kept) != len(verdicts):
        _write_verdicts(path, kept)


def merge_tree(base: str, head: str, cwd: str | Path) -> subprocess.CompletedProcess:
    """Run `git merge-tree --write-tree <base> <head>` without writing to the store.

    `merge-tree` writes every tree and merged blob of its result as a loose object,
    and a content check only needs the result's OID. The merge therefore runs against a
    scratch object directory, with the repository's own store as an alternate for
    reading, and the scratch directory is deleted when the call returns. Left in the
    store, each unlanded branch's result is unreachable and inside gc's prune window,
    so one per branch per run piles up until `git gc --auto` writes `gc.log` and stops.

    The exit code and output are git's: 0 for a clean merge, 1 for a conflict, anything
    else for a failure, such as a git older than 2.38, which lacks `--write-tree`.
    """
    common = _git_stdout(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=cwd
    )
    args = ["git", "merge-tree", "--write-tree", base, head]
    if not common:
        return git(*args[1:], cwd=cwd)
    with tempfile.TemporaryDirectory(prefix="merge-tree-") as scratch:
        env = git_env()
        env["GIT_OBJECT_DIRECTORY"] = scratch
        env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = str(Path(common) / "objects")
        return subprocess.run(
            args, cwd=cwd, env=env, capture_output=True, text=True, check=False
        )


def _compute_local_layer(repo: str, head: str, base: str) -> tuple[str | None, bool]:
    """(layer, settled). `settled` is False when a git call failed, not answered.

    Only a settled answer is cached: a failed call reads as not landed, the KEEP
    direction, and recording it would keep that tree from ever being pruned.
    """
    if git("merge-base", "--is-ancestor", head, base, cwd=repo).returncode == 0:
        return "ancestry", True
    cherry = git("cherry", base, head, cwd=repo)
    if cherry.returncode != 0:
        return None, False
    # An empty listing is no evidence. Past the ancestry test it means every commit
    # the base lacks is a merge commit, which `git cherry` skips, and the content
    # layer below is the one that can judge those.
    if cherry_says_landed(cherry.stdout, empty_means=False):
        return "patch-id", True
    base_tree = git("rev-parse", f"{base}^{{tree}}", cwd=repo)
    if base_tree.returncode != 0:
        return None, False
    merged = merge_tree(base, head, cwd=repo)
    if merged.returncode == 0 and merge_tree_says_contained(
        merged.stdout, base_tree.stdout
    ):
        return "content", True
    # Exit 1 is a conflict: a settled "no verdict". Any other non-zero is a failure.
    return None, merged.returncode in (0, 1)


def local_layer(repo: str, head: str, base: str) -> str | None:
    """The local layer that found `head` landed on `base`, or None when none did.

    One of `ancestry`, `patch-id` or `content`: the three that cost no network
    round-trip. A settled answer is read from and written to the verdict cache.
    """
    key = verdict_key(repo, head, base)
    if key is not None:
        cached = read_verdicts(repo).get(key)
        if cached is not None:
            # "forge" was written over whatever the local layers had said.
            return cached if cached in LOCAL_LAYERS else None
    layer, settled = _compute_local_layer(repo, head, base)
    if settled and key is not None:
        record_verdict(repo, key, layer or "")
    return layer


# What GitHub's compare calls a base that is an ancestor of its head, or the same
# commit.
CONTAINED = frozenset({"ahead", "identical"})


def _forge_gh(*args: str, cwd: str) -> subprocess.CompletedProcess:
    """`gh <args>` on `forge_says_merged`'s executable: `GH_BIN` when set."""
    env = dict(os.environ, GH_PROMPT_DISABLED="1", GH_NO_UPDATE_NOTIFIER="1")
    return subprocess.run(
        [os.environ.get("GH_BIN", "gh"), *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )


def contained_in_merged_pr(
    repo: str,
    head: str,
    branch: str,
    run_gh: Callable[..., subprocess.CompletedProcess] = _forge_gh,
) -> bool:
    """True when a merged PR for `branch` has a head that contains `head`.

    `forge_says_merged` matches the forge's merged head to the local tip exactly. That
    misses a branch whose lander merged the base into it on the remote before the
    merge: the merged head is the local tip plus that merge commit, so the SHAs differ.
    GitHub's compare answers `ahead` or `identical` when `head` is an ancestor of the
    merged head, which proves every local commit was in the merged PR. A tip that was
    never pushed, or has commits the merged head lacks, compares `diverged`, `behind`
    or 404, and a `gh` that fails reads as not contained.

    Still keyed on the SHA relation and never on "a merged PR exists under this name",
    so a reused branch name cannot delete work that never landed.
    """
    if not head or not branch:
        return False
    try:
        heads = run_gh(
            "pr", "list", "--state", "merged", "--head", branch,
            "--json", "headRefOid", "--jq", ".[].headRefOid",
            cwd=repo,
        )  # fmt: skip
        if heads.returncode != 0:
            return False
        for merged_head in heads.stdout.split():
            compared = run_gh(
                "api", f"repos/{{owner}}/{{repo}}/compare/{head}...{merged_head}",
                "--jq", ".status", cwd=repo,
            )  # fmt: skip
            if compared.returncode == 0 and compared.stdout.strip() in CONTAINED:
                return True
    except (OSError, subprocess.TimeoutExpired):
        return False
    return False


def forge_says_landed(repo: str, branch: str, head: str) -> bool:
    """The forge layer: GitHub merged `head` itself, or a merged PR's head holds it."""
    return forge_says_merged(repo, branch, head) or contained_in_merged_pr(
        repo, head, branch
    )


def forge_confirms(
    repo: str,
    head: str,
    branch: str,
    base: str,
    forge: Callable[[str, str, str], "bool | None"] = forge_says_landed,
) -> bool:
    """Whether the forge says `head` landed, answered from the verdict cache if it can.

    A "merged" is recorded for good. A "not merged" is recorded with the time it was
    asked and trusted for FORGE_NO_TTL_S.

    Args:
        repo: the checkout to ask from.
        head: the commit asked about.
        branch: the branch a merged PR would name as its head.
        base: the ref the verdict is cached against.
        forge: the read itself, taking (repo, branch, head). It returns None when it
            did not ask, such as a caller's time budget running out, and that answer
            is not recorded.
    """
    key = verdict_key(repo, head, base)
    no_key = None
    if key is not None:
        no_key = f"{_FORGE_NO}{key.split(':')[0]}:{branch}"
        verdicts = read_verdicts(repo)
        if verdicts.get(key) == FORGE:
            return True
        asked_at = verdicts.get(no_key, "")
        if asked_at.isdigit() and time.time() - int(asked_at) < FORGE_NO_TTL_S:
            return False
    answer = forge(repo, branch, head)
    if answer and key is not None:
        record_verdict(repo, key, FORGE)
    elif answer is False and no_key is not None:
        record_verdict(repo, no_key, str(int(time.time())))
    return bool(answer)


def merged_layer(
    repo: str,
    head: str,
    branch: str,
    base: str,
    forge: Callable[[str, str, str], "bool | None"] = forge_says_landed,
) -> str | None:
    """The layer that found `head`'s work on `base`, or None when none did.

    One of `ancestry`, `patch-id`, `content` or `forge`, asked in that order, so the
    forge is reached only by a head no local layer settled. All four failures are
    closed: an unknown reads as not landed.
    """
    layer = local_layer(repo, head, base)
    if layer is not None:
        return layer
    return FORGE if forge_confirms(repo, head, branch, base, forge) else None


# --- the holds ---------------------------------------------------------------------

# How long a branch that has never moved since its creation is kept whatever the
# ancestry test says. A week covers a session that idles before its first commit; past
# it, an untouched tree is a read-only session's leftover and is judged like any other.
FRESH_GRACE_S = 7 * 24 * 3600


def tree_created(tree_path: str) -> float | None:
    """When was this worktree added? None when git cannot say.

    `git worktree add` writes `commondir` into the tree's admin dir once, and no later
    git command rewrites it, so its mtime is the creation time.
    """
    admin = _git_stdout(
        ["rev-parse", "--path-format=absolute", "--git-dir"], cwd=tree_path
    )
    if not admin:
        return None
    try:
        return (Path(admin) / "commondir").stat().st_mtime
    except OSError:
        return None


def is_fresh(
    repo: str, branch: str, now: float | None = None, tree_path: str | None = None
) -> bool:
    """Has this branch stayed where it was created, within the last FRESH_GRACE_S?

    A session's worktree is cut at the default branch's tip, so until its first commit
    the branch IS an ancestor of the default branch, and a sweep that ran in that
    window removed the tree the session was starting in. Only meaningful for a branch
    whose tip is already an ancestor, the one case where "never moved" changes the
    verdict.

    Reads the branch's reflog. Exactly one `branch: Created from` entry is fresh, timed
    by that entry. No entry at all is fresh when `tree_path` is given, timed by the
    tree's admin dir (see `tree_created`): the desktop app cuts `claude/*` branches
    without writing a reflog, and git writes a branch's first entry the first time it
    moves the branch, so an empty reflog still means the tip never moved. Anything
    else reads as not fresh. An orphan branch has no tree to time, so its empty reflog
    reads as not fresh.

    Args:
        repo: the primary checkout.
        branch: the branch's short name.
        now: the current time, for tests.
        tree_path: the worktree the branch is checked out in, if any.
    """
    now = time.time() if now is None else now
    # The entry's own time comes from the selector, `<ref>@{<unix>}` under
    # --date=unix. `%ct` would be the tip commit's date, which for a branch that never
    # moved is when the default branch's tip was committed.
    entries = _git_stdout(
        [
            "reflog",
            "show",
            "--date=unix",
            "--format=%gd%x09%gs",
            f"refs/heads/{branch}",
        ],
        cwd=repo,
    ).splitlines()
    if not entries and tree_path is not None:
        created = tree_created(tree_path)
        return created is not None and now - created < FRESH_GRACE_S
    if len(entries) != 1:
        return False
    selector, _, subject = entries[0].partition("\t")
    if not subject.startswith("branch: Created from"):
        return False
    try:
        created = int(selector.rpartition("@{")[2].rstrip("}"))
    except ValueError:
        return False
    return now - created < FRESH_GRACE_S


def is_dirty(path: str) -> bool:
    """Does this tree hold uncommitted work? Anything short of a clean answer says yes.

    Untracked files count: an unlanded scratch file is exactly what must stop a prune.
    The index is shared across a repo's worktrees, so a `git status` that fails is
    usually another session mid-write, not a broken tree. Reading that as "clean" is
    the one wrong answer that costs work, so a failed call and a directory that has
    vanished both count as dirty.
    """
    result = git("status", "--porcelain", cwd=path)
    return result.returncode != 0 or bool(result.stdout.strip())


# A lock whose reason names a systemd user unit carries no pid, so `session_is_alive`
# cannot judge it and reads it as live for ever. The unit owns such a lock, so the
# unit's state decides. A lock younger than the grace is live whatever the unit says:
# a launcher takes the lock before it starts the unit, and a fresh tree at the default
# branch's tip already reads as landed.
UNIT_LOCK_GRACE_S = 86400
DEAD_UNIT_STATES = frozenset({"inactive", "failed"})


def unit_state(unit: str) -> str | None:
    """The caller's systemd user manager's ActiveState for `unit`.service.

    A unit the manager does not know reads `inactive`, which is what a finished
    transient unit becomes once it is collected.

    Returns:
        The state string, or None when the manager could not be asked. A system
        service running as a user has no `XDG_RUNTIME_DIR`, so this supplies the
        caller's own.
    """
    env = {"XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}", **os.environ}
    command = ["systemctl", "--user", "show", "-p", "ActiveState", "--value"]
    try:
        proc = subprocess.run(
            [*command, f"{unit}.service"],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def lock_age(tree: str, now: float) -> float | None:
    """Seconds from `git worktree lock` writing `tree`'s lock file to `now`, or None."""
    try:
        gitdir = Path(tree, ".git").read_text().removeprefix("gitdir:").strip()
        return now - Path(gitdir, "locked").stat().st_mtime
    except OSError:
        return None


def unit_lock_is_live(
    tree: str,
    unit: str,
    state: Callable[[str], "str | None"] = unit_state,
    now: float | None = None,
    foreign: "Callable[[str], str | None] | None" = None,
    uid: int | None = None,
) -> bool:
    """Whether the systemd user unit that owns `tree`'s lock may still be using it.

    Every doubt reads as live: a manager that cannot be asked, a lock file that cannot
    be read, a lock younger than UNIT_LOCK_GRACE_S, and a tree another user owns, whose
    units sit under that user's manager.

    Args:
        tree: the worktree's path.
        unit: its lock reason, the unit's name without `.service`.
        state: `unit_state`-shaped; a test seam.
        now: the time to measure the lock's age at; the clock's when None.
        foreign: `unit_state`-shaped, for a tree another user owns. None reads every
            such tree as live, which a caller that removes trees needs.
        uid: the caller's uid; the process's when None. A test seam.
    """
    try:
        owner = Path(tree).stat().st_uid
    except OSError:
        return True
    age = lock_age(tree, time.time() if now is None else now)
    if age is None or age < UNIT_LOCK_GRACE_S:
        return True
    if owner != (os.getuid() if uid is None else uid):
        if foreign is None:
            return True
        return foreign(unit) not in DEAD_UNIT_STATES
    return state(unit) not in DEAD_UNIT_STATES


def lock_is_live(
    tree: Worktree,
    unit_locks: "re.Pattern[str] | None" = None,
    state: Callable[[str], "str | None"] = unit_state,
    now: float | None = None,
    foreign: "Callable[[str], str | None] | None" = None,
) -> bool:
    """Whether `tree`'s lock owner may still be using it.

    Args:
        tree: the locked worktree.
        unit_locks: matches, whole, a lock reason that names a systemd user unit. A
            repo whose launcher locks trees that way supplies it; with None every
            reason is judged as a Claude session's.
        state: `unit_lock_is_live`'s test seam.
        now: `unit_lock_is_live`'s test seam.
        foreign: judges a unit-locked tree another user owns, as `unit_lock_is_live`
            describes.
    """
    if unit_locks is not None and unit_locks.fullmatch(tree.lock_reason):
        return unit_lock_is_live(tree.path, tree.lock_reason, state, now, foreign)
    return session_is_alive(tree.lock_reason)


def _inside(held: str, tree: Path) -> bool:
    """Whether the path `held` is `tree` or somewhere below it."""
    path = Path(held).resolve()
    return path == tree or tree in path.parents


# A root-run scan some hosts ship, and the socket systemd answers it on, one service
# instance per connection. `/proc/<pid>/cwd` and `environ` refuse another user's
# process, so on a host where a second user runs sessions the scan below cannot see a
# process of that user standing in a tree. The helper reads every uid's, and reports
# only under the directory WORKTREE_HOLDER_ROOTS maps the caller's uid to.
WORKTREE_HOLDERS_SOCKET = "/run/worktree-holders.sock"
WORKTREE_HOLDER_ROOTS = "/etc/worktree-holders.json"
_HELPER_KINDS = ("cwd", "CLAUDE_PROJECT_DIR", "unreadable")


def holder_root(roots: str = WORKTREE_HOLDER_ROOTS) -> Path | None:
    """The directory the root helper reports under for this user, or None.

    It is this user's entry in `roots`, the map the helper itself reads, so a caller
    never asks about a tree the helper does not scan. None means no map, or no
    absolute entry for this user.
    """
    try:
        import pwd

        name = pwd.getpwuid(os.getuid()).pw_name
        mapping = json.loads(Path(roots).read_text())
    except (ImportError, KeyError, OSError, ValueError):
        return None
    held = mapping.get(name) if isinstance(mapping, dict) else None
    if isinstance(held, str) and held.startswith("/"):
        return Path(held)
    return None


def ask_holders(sock: str = WORKTREE_HOLDERS_SOCKET, timeout: float = 120) -> bytes:
    """Everything the root helper sends back on one connection to `sock`.

    The caller sends nothing: the service names the caller by the uid the kernel
    recorded for this connection (`SO_PEERCRED`), so there is no request to forge.

    Raises:
        OSError: when the connection fails or `timeout` passes first.
    """
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(sock)
        chunks = []
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
    return b"".join(chunks)


_NO_ROOT = object()


def privileged_holders(
    tree: Path,
    sock: str = WORKTREE_HOLDERS_SOCKET,
    root: "Path | None | object" = _NO_ROOT,
    ask: Callable[[str], bytes] = ask_holders,
) -> "list[tuple[int, str]] | None":
    """(pid, how) for every process the root helper reports inside `tree`, or None.

    None means the helper does not apply, and the caller scans `/proc` itself. That is
    the case for a tree outside `root`, which the helper never reports on, for a host
    with no socket, and for a caller the socket's group shuts out. A session started
    before its user joined that group is one of those until it restarts.

    The socket needs no setuid, so a caller with `NoNewPrivs` set asks it too.

    Args:
        tree: the resolved worktree directory.
        sock: the helper's socket.
        root: the directory the helper reports under; `holder_root()` when omitted.
            None is a user the helper's map does not name: the socket is still asked
            where it exists, and the helper's own refusal then refuses the removal.
        ask: reads the helper's whole answer from `sock`.
    """
    # DECIDED: the socket fails closed once it accepts, and an absent socket or a
    # connect refused for permission falls back to the slice rule. The helper reads
    # every uid's cwd and environ, so a gap in its answer is a process that could hold
    # this tree, and a refused removal is retried at the next sweep. Neither fallback
    # can fail closed the same way: without root, another user's sessions are always
    # unreadable, so that rule would refuse every removal on a host with no helper
    # and in every session older than its user's group grant. The fallback says so on
    # stderr where the map names this user, which is a host meant to have the helper.
    if root is _NO_ROOT:
        root = holder_root()
    if root is not None and not _inside(str(tree), Path(root).resolve()):
        return None
    try:
        raw = ask(sock)
    except (FileNotFoundError, PermissionError) as e:
        if root is not None:
            _warn_scan_unreachable(sock, e.strerror or str(e))
        return None
    except OSError as e:
        return [(0, f"{sock} did not answer: {e}")]
    return read_answer(raw, tree, sock)


def read_answer(raw: bytes, tree: Path, sock: str) -> list[tuple[int, str]]:
    """(pid, how) for each holder of `tree` in the helper's answer, or a refusal.

    A refusal is one `(0, reason)` entry, which the caller reads as a holder it cannot
    name. The answer must open with the `ok` header and close with the `end`
    terminator, because a socket carries no exit status: an instance that died
    mid-scan sends a prefix of a good answer, or nothing at all, and neither may read
    as "no holders".

    Each value arrives escaped with `unicode_escape`, so a path holding a line break
    or a tab is still one line. It is decoded before it is compared, and the escaped
    form names it in the refusal, where it stays one printable line.
    """
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        return [(0, f"{sock} answered bytes that are not ASCII: {raw[:200]!r}")]
    lines = text.split("\n")
    head = lines[0]
    if head.startswith("refused\t") and lines[1:] == [""]:
        return [(0, f"{sock} refused: {head.partition(chr(9))[2]}")]
    if head != "ok" or lines[-2:] != ["end", ""]:
        return [(0, f"{sock} answered without its framing: {text[:200]!r}")]
    found = []
    for line in lines[1:-2]:
        pid, _, rest = line.partition("\t")
        kind, _, value = rest.partition("\t")
        held = _unescape(value)
        if not pid.isdigit() or not held or kind not in _HELPER_KINDS:
            return [(0, f"{sock} answered an unparseable line: {line!r}")]
        if kind == "unreadable":
            found.append((int(pid), f"unreadable even to root ({value})"))
        elif _inside(held, tree):
            how = f"cwd {value}" if kind == "cwd" else f"{kind}={value}"
            found.append((int(pid), how))
    return found


def escape_holder(value: str) -> str:
    """`value` escaped the way the root helper escapes a path it reports.

    `unicode_escape` encodes each character on its own, so the escaped form of a path
    inside a tree starts with the escaped tree and a `/`.
    """
    return value.encode("unicode_escape").decode("ascii")


def _unescape(value: str) -> str:
    """The path `escape_holder` made `value` from, or "" when it made no such value."""
    try:
        held = value.encode("ascii").decode("unicode_escape")
    except UnicodeError:
        return ""
    # A path holds no NUL, and Path.resolve raises on one.
    return "" if "\0" in held else held


@functools.cache
def _warn_scan_unreachable(sock: str, why: str) -> None:
    print(
        f"warning: cannot connect to {sock} ({why}), so a process of another uid "
        "outside this login slice is invisible to the in-use check. A session started "
        "before its user joined the socket's group must restart first.",
        file=sys.stderr,
    )


def processes_using(
    path: str,
    proc: Path = Path("/proc"),
    privileged: "Callable[[Path], list[tuple[int, str]] | None] | None" = None,
) -> list[tuple[int, str]]:
    """(pid, how) for every live process whose cwd or `CLAUDE_PROJECT_DIR` is in `path`.

    A session whose project dir is deleted loses every repo hook, and its worktree
    lock is no proof it is gone: the session can run from a tree it never locked, and
    a lock's owner pid says nothing about a shell or hook that `cd`'d in. A detached
    landing keeps running from its tree after the merge that makes it removable. So a
    removal asks the kernel which processes still use the directory.

    The root helper answers first where it applies; see `privileged_holders`. Without
    it, the scan is `process_holds`.

    Args:
        path: the worktree directory.
        proc: the procfs root to scan when the helper does not answer.
        privileged: the helper's reader, `privileged_holders` when None. It returns
            None when the helper does not apply to this caller.
    """
    tree = Path(path).resolve()
    answer = (privileged or privileged_holders)(tree)
    if answer is not None:
        return answer
    roots = tree_roots(path)
    found = []
    seen = set()
    # A process can hold the tree twice, by cwd and by CLAUDE_PROJECT_DIR; it is
    # named once, by the first hold the scan reports.
    for pid, held, how in process_holds(str(proc)):
        if pid in seen or not holds_tree(held, roots):
            continue
        seen.add(pid)
        if how == FOREIGN_UID:
            found.append(
                (pid, "another uid's process in this uid's login slice, unreadable")
            )
        elif how == "cwd":
            found.append((pid, f"cwd {held}"))
        else:
            found.append((pid, f"{how}={held}"))
    return found


IN_USE = "in use by a live process"


def in_use_reason(path: str) -> str:
    """Why `path` must not be removed: IN_USE and each pid using it, or "" when free.

    A removal refused with this reason is a skip, not a failure: a later sweep removes
    the directory once its holder exits.
    """
    users = processes_using(path)
    if not users:
        return ""
    return f"{IN_USE}: " + "; ".join(f"pid {pid} ({how})" for pid, how in users)


# --- the verdict, and acting on it --------------------------------------------------

REMOVABLE = "removable"
KEEP = "keep"
# Landed by a layer the caller does not let act: reported, never removed.
REVIEW = "review"

# The layers that are proof on their own; see the ladder's header comment.
PROOF_LAYERS = frozenset({"ancestry", FORGE})


def kept_reason(
    tree: Worktree,
    dirty: bool,
    *,
    is_current: bool = False,
    lock_live: Callable[[Worktree], bool] = lock_is_live,
) -> str | None:
    """Why `tree` is kept whatever its branch says, or None when its branch decides.

    The holds that need no merge check, in the order a person would act on them. A
    sweep asks this first and pays for the ladder only on the trees it leaves open.

    Args:
        tree: the worktree.
        dirty: `is_dirty`'s answer.
        is_current: the tree is the calling session's own.
        lock_live: judges a locked tree's owner; a test seam, and where a caller binds
            `lock_is_live`'s `unit_locks`.
    """
    if is_current:
        return "this session's own worktree"
    if tree.locked and lock_live(tree):
        return f"in use — {tree.lock_reason or 'locked'}"
    if dirty:
        return "uncommitted changes"
    if tree.branch is None:
        return "detached HEAD — no branch to check"
    return None


def classify(
    tree: Worktree,
    layer: str | None,
    dirty: bool,
    *,
    acts: "frozenset[str]" = PROOF_LAYERS,
    is_current: bool = False,
    fresh: bool = False,
    lock_live: Callable[[Worktree], bool] = lock_is_live,
) -> tuple[str, str]:
    """Return (verdict, reason) for one worktree.

    Reasons are reported in priority order, so the output names the blocking condition
    a person would act on first. A REMOVABLE tree can still be refused by `remove`,
    which checks for a live process at the moment it acts.

    Args:
        tree: the worktree.
        layer: what `merged_layer` said of its head, or None for not landed.
        dirty: `is_dirty`'s answer.
        acts: the layers that make a tree REMOVABLE. A landed layer outside it gives
            REVIEW.
        is_current: `kept_reason`'s.
        fresh: `is_fresh`'s answer. It keeps the tree whatever `layer` says.
        lock_live: `kept_reason`'s.
    """
    held = kept_reason(tree, dirty, is_current=is_current, lock_live=lock_live)
    if held is not None:
        return KEEP, held
    if fresh:
        return KEEP, f"{tree.branch} has no commits of its own yet"
    if layer is None:
        return KEEP, f"{tree.branch} not merged"
    lock = "lock owner is dead" if tree.locked else "unlocked"
    if layer in acts:
        if layer == "ancestry":
            return REMOVABLE, f"{tree.branch} merged, clean, {lock}"
        if layer == FORGE:
            return REMOVABLE, (
                f"{tree.branch} merged as a pull request from this tip, clean, {lock}"
            )
        return REMOVABLE, f"{tree.branch} landed by {layer}, clean, {lock}"
    settle = (
        f"`ghread pr list --state merged --search head:{tree.branch}` names the merge"
    )
    if layer == "patch-id":
        return REVIEW, (
            f"{tree.branch} is not an ancestor of the default branch, but every "
            "commit on it already has an equivalent there — landed by a squash or "
            "rebase merge, OR simply older than what is on the default branch. "
            f"Before removing, establish which: {settle}, and `git diff --stat "
            f"<default> {tree.branch}` shows whether the branch is behind rather "
            "than landed."
        )
    return REVIEW, (
        f"{tree.branch} is not an ancestor of the default branch and no commit on "
        "it has a patch-id match there, but merging it would change nothing — its "
        "content is already on the default branch. That is what a squash merge "
        "leaves behind, OR a branch that later work superseded. Before removing, "
        f"establish which: {settle}, and `git log --oneline <default>.."
        f"{tree.branch}` lists the commits whose content would be lost."
    )


def remove(repo: str, tree: Worktree) -> tuple[bool, str]:
    """Refuse while a process uses the tree; otherwise unlock if needed, then remove.

    The process check runs right before the unlock, so a refusal leaves the lock
    exactly as it was, and a session that started in the tree after the caller
    classified it still stops the removal. It is skipped when the directory is
    already gone: deregistering a deleted tree cannot break a session still pointing
    at it. The refusal starts with IN_USE and names each pid.

    Never --force: git's own refusal on a tree with uncommitted or untracked files is
    the backstop that makes the unlock safe. A caller only passes a locked tree whose
    owner `lock_is_live` found dead. Without the unlock, `git worktree remove` fails
    outright on a locked tree.
    """
    if Path(tree.path).exists():
        held = in_use_reason(tree.path)
        if held:
            return False, held
    if tree.locked:
        git("worktree", "unlock", tree.path, cwd=repo)
    result = git("worktree", "remove", tree.path, cwd=repo)
    return result.returncode == 0, result.stderr.strip()


def foreign_owned_paths(
    root: str, owner: "Callable[[str], int | None] | None" = None
) -> list[str]:
    """The topmost paths under `root` that a uid other than ours owns.

    Neither `git worktree remove` nor a plain `rm` can delete such a path, and the
    error they print names no path. A foreign-owned directory is reported without its
    contents: deleting it deletes them, and it is often unreadable anyway.

    Args:
        root: the directory to walk.
        owner: returns a path's owning uid, or None once it is gone; a test seam.
    """

    def lstat_uid(path: str) -> int | None:
        try:
            return os.lstat(path).st_uid
        except OSError:
            return None

    owner = owner or lstat_uid
    if not hasattr(os, "getuid"):  # Windows: no uid to compare
        return []
    uid = os.getuid()

    def foreign(path: str) -> bool:
        # A path that vanished mid-walk, or a root that never existed, blocks nothing.
        return owner(path) not in (uid, None)

    if foreign(root):
        return [root]
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        for name in sorted(dirnames):
            path = os.path.join(dirpath, name)
            if foreign(path):
                found.append(path)
                dirnames.remove(name)
        found.extend(
            path
            for path in (os.path.join(dirpath, name) for name in sorted(filenames))
            if foreign(path)
        )
    return sorted(found)


def foreign_owned_advice(
    root: str, owner: "Callable[[str], int | None] | None" = None
) -> list[str]:
    """Lines naming what under `root` blocks its removal, and the command to clear it.

    Empty when every path is ours, so a removal git refused for another reason reports
    only git's own error. The command deletes the named paths and nothing else: when
    git refused before deleting anything, the tree still holds work that a `rm -rf` of
    the whole tree would lose.
    """
    paths = foreign_owned_paths(root, owner)
    if not paths:
        return []
    return [
        f"  {len(paths)} path(s) owned by another user, which uid {os.getuid()} "
        "cannot delete:",
        *(f"    {path}" for path in paths),
        "  → an operator clears them with: sudo rm -rf -- "
        + " ".join(shlex.quote(path) for path in paths),
    ]


# Long enough that no live session's just-written objects are in range, short enough
# to bound the growth.
PRUNE_GRACE = "1.day.ago"


def repair_object_store(cwd: str | Path) -> list[str]:
    """Drop the unreachable objects worktree churn leaves, and clear a stale `gc.log`.

    Removing a worktree makes its branch's objects unreachable. `git gc --auto` is
    meant to absorb that, but when it runs and still finds unreachable loose objects
    it may not delete, it writes `gc.log`, and the next `git gc --auto` prints that log
    and exits without running, for `gc.logExpiry`. Nothing bounds the growth in
    between.

    `--expire=1.day.ago`, never `--expire=now`. Several sessions write into one object
    store at once, and an object a live session has written but not yet pointed a ref
    at is unreachable and brand new, which is exactly what `now` deletes.

    `gc.log` is removed last and unconditionally: while it is there and fresh,
    automatic gc prints it and exits however clean the store has since become.

    Every step is best-effort, because a caller runs this after work that already
    succeeded.

    Returns:
        One line per step taken, for the caller to print.
    """
    lines = []
    git("worktree", "prune", cwd=cwd)
    pruned = git("prune", f"--expire={PRUNE_GRACE}", cwd=cwd)
    if pruned.returncode == 0:
        lines.append(f"pruned unreachable objects older than {PRUNE_GRACE}")
    else:
        lines.append(f"git prune failed: {pruned.stderr.strip()}")
    common = _git_stdout(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=cwd
    )
    log = Path(common or Path(cwd) / ".git") / "gc.log"
    try:
        log.unlink()
        lines.append(f"removed {log} — automatic gc no longer prints it and exits")
    except FileNotFoundError:
        pass
    except OSError as error:
        lines.append(f"could not remove {log}: {error}")
    return lines
