"""Report and remove the Claude session worktrees a repository is done with.

Every session that isolates its work gets a worktree under `.claude/worktrees/`, and
nothing removes one when its branch lands: Claude Code's exit prompt only covers a
session still attached when it ends. This is the one pruner. `prune-worktrees.py` in
`~/.claude/hooks` starts it, as the SessionStart hook and as a command.

A worktree is removed only when all of these hold. `claude_worktree` owns each check.

- It sits directly under the primary checkout's `.claude/worktrees/`. A tree made by
  hand elsewhere is never this sweep's to delete.
- Its branch has landed on the remote's default branch, by a layer the repo lets act.
  Ancestry and the forge are proof and always act. A patch-id or content match acts
  only where the repo's policy lists it; elsewhere it is reported for review.
- Its branch has moved since it was created, or is older than a week.
- It has no uncommitted or untracked file, and it is not the calling session's own.
- No live owner holds its lock, and no live process has it as its cwd or its
  `CLAUDE_PROJECT_DIR`. A detached landing keeps running from its tree after the merge
  that makes it removable, so the process check runs right before each removal.

Removal never passes `--force`.

The sweep then deletes the session branches no worktree holds, by the same ladder
(`judge_branches`), and in a full `--prune` also removes orphan directories that hold
nothing git lacks (`unstored_files`) and repairs the object store.

Two ways to run it differ in how much time they may spend:

- `--hook` is the SessionStart sweep. It removes and deletes, inside a forge budget,
  and skips the orphan-directory and object-store work. It always exits 0, says
  nothing when it changed nothing, and stands aside when another sweep holds the lock.
- `--prune` is the full sweep, for a timer or a hand run. It exits 1 when something it
  tried to remove is still there.

A repository states its own policy in `.claude/prune-worktrees.json`, read from the
primary checkout. See `read_policy` for the keys.

Usage:
    prune-worktrees.py                  # report
    prune-worktrees.py --all            # report, kept worktrees listed too
    prune-worktrees.py --prune          # full sweep
    prune-worktrees.py --brief          # short report, silent when clean
    prune-worktrees.py --check          # what the branch sweep would delete, and why
    prune-worktrees.py --check BRANCH   # has this branch's work landed?
    prune-worktrees.py --gc             # the object-store repair alone
    prune-worktrees.py --hook           # the SessionStart sweep

`--check BRANCH` prints `BRANCH: landed (<layer>)` or `BRANCH: unlanded` and exits 0 or
1. Exit 64 is a branch that does not resolve, 75 a `--prune` that could not take the
sweep lock, and 78 a policy file that does not parse or a `--require` this copy is too
old for.

CLAUDE_WORKTREE_AUTOPRUNE=0 switches the SessionStart sweep off. Every removal is
logged to `~/.claude/logs/sessions.log`.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import select
import shutil
import stat
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import claude_worktree as cw
from claude_worktree import KEEP, REMOVABLE, REVIEW, Worktree, git

try:
    import fcntl
except ImportError:  # Windows has no fcntl; the sweep lock is skipped there.
    fcntl = None

OK, FAILED, USAGE_ERROR, LOCK_BUSY, CONFIG_ERROR = 0, 1, 64, 75, 78

VANISHED = "vanished"
ORPHAN = "orphan"
STALE = "stale"

POLICY_FILE = Path(".claude") / "prune-worktrees.json"

# The whole SessionStart run's allowance for GitHub lookups. The hook's timeout is 15s
# and the local git work takes a few of those; a lookup that would start past the
# budget is skipped, which leaves its tree where the local layers put it.
FORGE_BUDGET_S = 6.0

# Held by a sweep that removes, for its whole run, in the git common dir so every
# worktree of the repo contends for the same file.
PRUNE_LOCK = "claude-prune-worktrees.lock"
# How long a full sweep waits for a SessionStart sweep to finish with the lock.
LOCK_WAIT_S = 60.0

LOG_PATH = (
    Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    / "logs"
    / "sessions.log"
)

# How the hint lines name this command: the one path every caller runs.
COMMAND = "~/.claude/hooks/prune-worktrees.py"


class PolicyError(Exception):
    """A repository's policy file exists and cannot be used as written."""


@dataclass(frozen=True)
class Policy:
    """What one repository lets the sweep do; the defaults are the strictest.

    Attributes:
        session_start: whether the SessionStart sweep runs here at all.
        acts: the landed layers that remove a tree or delete a branch.
        branch_prefixes: the branch names the branch sweep may delete.
        unit_locks: matches a lock reason that names a systemd user unit, or None.
        branch_holds: a command that prints the branches the repo holds, or empty.
        label_file: a file at a worktree's root whose first line labels it, or "".
    """

    session_start: bool = True
    acts: frozenset[str] = cw.PROOF_LAYERS
    branch_prefixes: tuple[str, ...] = ("worktree-",)
    unit_locks: re.Pattern[str] | None = None
    branch_holds: tuple[str, ...] = ()
    label_file: str = ""


def _strings(value: object, key: str) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise PolicyError(f"{key} must be a list of strings")
    return tuple(value)


def read_policy(repo: str) -> Policy:
    """The policy in `repo`'s `.claude/prune-worktrees.json`; the defaults with no file.

    The keys, every one optional:

    - `session_start`: `"off"` keeps the SessionStart sweep out of this repo, for one
      that prunes from a timer. `"prune"` is the default.
    - `landed_by`: the local layers, of `patch-id` and `content`, that may remove a
      tree and delete a branch here. Without it only ancestry and the forge act.
    - `branch_prefixes`: the branch-name prefixes the branch sweep may delete. The
      default is `worktree-`, the form EnterWorktree creates.
    - `unit_locks`: a regular expression. A worktree lock whose whole reason matches
      names a systemd user unit, and is dead once that unit is inactive and the lock
      is a day old (`claude_worktree.unit_lock_is_live`).
    - `branch_holds`: a command, as an argv list, run in the primary checkout. It
      prints one branch per line that the sweep must not delete, such as the head of
      an open PR. A non-zero exit keeps every branch the sweep would have deleted.
    - `label_file`: a file name. Where a worktree's root holds it, reports print its
      first line beside the tree.

    Raises:
        PolicyError: the file is not a JSON object, or holds a key or value this
            reader does not know. An unknown key is refused, never ignored: a
            misspelt `session_start` would otherwise switch the sweep on.
    """
    try:
        text = (Path(repo) / POLICY_FILE).read_text()
    except FileNotFoundError:
        return Policy()
    except OSError as exc:
        raise PolicyError(str(exc)) from exc
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise PolicyError(f"not JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise PolicyError("not a JSON object")
    unknown = sorted(set(data) - set(_POLICY_KEYS))
    if unknown:
        raise PolicyError(f"unknown key(s): {', '.join(unknown)}")
    fields: dict[str, object] = {}
    if "session_start" in data:
        if data["session_start"] not in ("prune", "off"):
            raise PolicyError('session_start must be "prune" or "off"')
        fields["session_start"] = data["session_start"] == "prune"
    if "landed_by" in data:
        layers = _strings(data["landed_by"], "landed_by")
        if not set(layers) <= {"patch-id", "content"}:
            raise PolicyError('landed_by takes "patch-id" and "content"')
        fields["acts"] = cw.PROOF_LAYERS | frozenset(layers)
    if "branch_prefixes" in data:
        prefixes = _strings(data["branch_prefixes"], "branch_prefixes")
        if not prefixes or not all(prefixes):
            raise PolicyError("branch_prefixes must name at least one prefix")
        fields["branch_prefixes"] = prefixes
    if "unit_locks" in data:
        try:
            fields["unit_locks"] = re.compile(data["unit_locks"])
        except (re.error, TypeError) as exc:
            raise PolicyError(f"unit_locks is not a pattern: {exc}") from exc
    if "branch_holds" in data:
        fields["branch_holds"] = _strings(data["branch_holds"], "branch_holds")
    if "label_file" in data:
        label = data["label_file"]
        if not isinstance(label, str) or "/" in label:
            raise PolicyError("label_file must be a file name")
        fields["label_file"] = label
    return Policy(**fields)


_POLICY_KEYS = (
    "session_start",
    "landed_by",
    "branch_prefixes",
    "unit_locks",
    "branch_holds",
    "label_file",
)


@dataclass(frozen=True)
class Sweep:
    """One run's fixed inputs.

    Attributes:
        repo: the primary checkout.
        base: the remote's default branch ref, or "" when there is none. With no merge
            target nothing can be shown to have landed, so every tree is kept.
        policy: the repository's policy.
        forge: the forge read `claude_worktree.forge_confirms` takes.
        ask_unflagged: whether the forge is asked about a head no local layer flagged.
            The SessionStart sweep does not: one lookup per unlanded branch at every
            session start is a poll.
        current: the calling session's directories, resolved.
    """

    repo: str
    base: str
    policy: Policy
    forge: object = cw.forge_says_landed
    ask_unflagged: bool = True
    current: tuple[Path, ...] = ()

    def lock_live(self, tree: Worktree) -> bool:
        return cw.lock_is_live(tree, self.policy.unit_locks)

    def landed(self, head: str, branch: str) -> str | None:
        """The layer that settles `head` as landed, or the local one that flagged it.

        A local layer the policy lets act is the answer. Otherwise the forge is
        asked, and its "merged" is `forge`. Failing both, a flagged head keeps its
        local layer, which `classify` reports for review.
        """
        if not self.base:
            return None
        local = cw.local_layer(self.repo, head, self.base)
        if local in self.policy.acts:
            return local
        if (local or self.ask_unflagged) and cw.forge_confirms(
            self.repo, head, branch, self.base, self.forge
        ):
            return cw.FORGE
        return local

    def label(self, name: str, tree: str) -> str:
        """`name`, followed by ` [<label>]` when the tree carries the policy's label."""
        if not self.policy.label_file:
            return name
        try:
            text = (Path(tree) / self.policy.label_file).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return name
        first = text.strip().splitlines()[0].strip() if text.strip() else ""
        return f"{name} [{first[:80]}]" if first else name


def budgeted_forge(budget_s: float):
    """A forge read that stops asking once `budget_s` seconds have passed.

    It asks only for an exact-tip merge, one `gh` call. Past the budget it returns
    None, which `forge_confirms` does not record as an answer.
    """
    deadline = time.monotonic() + budget_s

    def forge(repo: str, branch: str, head: str) -> bool | None:
        remaining = deadline - time.monotonic()
        if remaining < 1.0:
            return None
        return cw.forge_says_merged(repo, branch, head, timeout=min(5.0, remaining))

    return forge


def log(message: str) -> None:
    """Append one line to the session log, the record of what the sweep removed.

    Silent on failure: a sweep that cannot write its log still has a job to do.
    """
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        with LOG_PATH.open("a") as handle:
            handle.write(f"{stamp} {message}\n")
    except OSError:
        pass


def _read_stdin(wait: float) -> str | None:
    """Return stdin's text, or None when it is not ready within `wait` seconds."""
    if sys.platform != "win32":
        if select.select([sys.stdin], [], [], wait)[0]:
            return sys.stdin.read()
        return None
    # select() only takes sockets on Windows, so read on a thread and bound the wait.
    box: list[str] = []

    def reader() -> None:
        with contextlib.suppress(OSError, ValueError):
            box.append(sys.stdin.read())

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    thread.join(wait)
    return box[0] if box else None


def _event_cwd(stdin_wait: float) -> Path | None:
    """The `cwd` of the hook input on stdin, when there is one and it is absolute."""
    try:
        if sys.stdin.isatty():
            return None
        text = _read_stdin(stdin_wait)
        data = json.loads(text) if text else None
    except (OSError, ValueError, RecursionError):
        return None
    value = data.get("cwd") if isinstance(data, dict) else None
    if not isinstance(value, str) or not value:
        return None
    path = Path(value).expanduser()
    return path if path.is_absolute() else None


def session_dirs(read_event: bool, stdin_wait: float = 0.5) -> tuple[Path, ...]:
    """The directories the calling session works in, resolved.

    The caller's own cwd is not enough. The desktop app runs SessionStart hooks from
    the primary checkout while the session itself starts in its worktree, so the
    hook input's `cwd` and the `CLAUDE_PROJECT_DIR` in the environment each count too.

    Args:
        read_event: whether stdin carries a hook input to read.
        stdin_wait: seconds to wait for it. An inherited pipe that never closes must
            not hang the sweep.
    """
    dirs = [Path.cwd()]
    input_cwd = _event_cwd(stdin_wait) if read_event else None
    if input_cwd is not None:
        dirs.append(input_cwd)
        if input_cwd.resolve() != dirs[0].resolve():
            # Kept so a change in where the app runs hooks shows up in the log.
            log(f"event=prune_session_dir hook_cwd={dirs[0]} input_cwd={input_cwd}")
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        dirs.append(Path(project_dir))
    return tuple(d.resolve() for d in dirs)


_held_locks: list[int] = []


def take_prune_lock(common_dir: Path, wait_s: float = 0.0) -> bool:
    """Take PRUNE_LOCK, waiting up to `wait_s`. False when another sweep holds it.

    Sweeps that start together race: several removed the same trees in the same
    second, and all but one failed with errors about a half-deleted tree. A lock file
    that cannot be opened returns True: the race only costs log noise, and a sweep
    that stood aside for an unreadable file would never prune at all.
    """
    if fcntl is None:
        return True
    try:
        fd = os.open(common_dir / PRUNE_LOCK, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        return True
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return False
            time.sleep(0.5)
        except OSError:
            os.close(fd)
            return True
        else:
            _held_locks.append(fd)
            return True


# --- worktrees ---------------------------------------------------------------------


def registered(repo: str) -> list[Worktree]:
    """Every worktree git registers for `repo`, the primary checkout first."""
    return cw.parse_worktree_list(
        git("worktree", "list", "--porcelain", cwd=repo).stdout
    )


def survey(sweep: Sweep) -> list[tuple[str, Worktree, str]]:
    """(verdict, worktree, reason) for every session worktree.

    A registration whose directory is gone reads VANISHED and is asked nothing else.
    It is never REMOVABLE: there is nothing to remove, and the `git worktree prune`
    in the object-store repair drops the registration.
    """
    sessions_dir = Path(sweep.repo) / ".claude" / "worktrees"
    out = []
    for tree in registered(sweep.repo)[1:]:
        if Path(tree.path).parent != sessions_dir:
            continue
        if not Path(tree.path).is_dir():
            reason = "directory gone — `--prune` drops the registration"
            out.append((VANISHED, tree, reason))
            continue
        resolved = Path(tree.path).resolve()
        held = cw.kept_reason(
            tree,
            cw.is_dirty(tree.path),
            is_current=any(
                d == resolved or resolved in d.parents for d in sweep.current
            ),
            lock_live=sweep.lock_live,
        )
        if held is not None:
            out.append((KEEP, tree, held))
            continue
        layer = sweep.landed(tree.head, tree.branch or "")
        # Fresh only matters where ancestry would remove the tree: a never-moved
        # branch cut from a commit the base lacks is judged by the other layers.
        fresh = layer == "ancestry" and cw.is_fresh(
            sweep.repo, tree.branch or "", tree_path=tree.path
        )
        verdict, reason = cw.classify(
            tree,
            layer,
            dirty=False,
            acts=sweep.policy.acts,
            fresh=fresh,
            lock_live=lambda _tree: False,
        )
        out.append((verdict, tree, reason))
    return out


# Compose labels every container with its project and the directory `up` ran in.
COMPOSE_PROJECT_LABEL = "com.docker.compose.project"
COMPOSE_DIR_LABEL = "com.docker.compose.project.working_dir"
DOCKER_TIMEOUT_S = 5.0
DOCKER_FALLBACKS = (
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
)


def compose_default_name(path: str) -> str:
    """The project name compose gives a directory when no -p or `name:` sets one."""
    kept = [
        c for c in Path(path).name.lower() if c.isascii() and (c.isalnum() or c in "-_")
    ]
    return "".join(kept).lstrip("-_")


def compose_stacks(
    tree_paths: list[str], rows: list[str]
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Split the compose projects started in `tree_paths` into (stop, keep) lists.

    `rows` are `project<TAB>working_dir` lines, one per container. A project carrying
    its directory's default name belongs to that tree alone, so it is stopped. A
    project named by -p or `name:` is kept: other worktrees can share it, and the
    label records only the directory that first created each container.
    """
    by_dir = {os.path.realpath(p): p for p in tree_paths}
    stop: dict[str, str] = {}
    keep: dict[str, str] = {}
    for row in rows:
        project, _, working_dir = row.partition("\t")
        tree = by_dir.get(os.path.realpath(working_dir)) if working_dir else None
        if not project or tree is None:
            continue
        if project == compose_default_name(tree):
            stop[project] = tree
        else:
            keep[project] = tree
    return sorted(stop.items()), sorted(keep.items() - stop.items())


def docker_bin() -> str:
    """The docker CLI, or "" when there is none. `DOCKER_BIN` overrides it for tests."""
    override = os.environ.get("DOCKER_BIN")
    if override:
        return override
    found = shutil.which("docker")
    if found:
        return found
    return next((p for p in DOCKER_FALLBACKS if os.access(p, os.X_OK)), "")


def compose_containers(docker: str) -> list[str] | None:
    """`project<TAB>working_dir` per compose container, or None when Docker is down."""
    project = f'{{{{.Label "{COMPOSE_PROJECT_LABEL}"}}}}'
    fmt = f'{project}\t{{{{.Label "{COMPOSE_DIR_LABEL}"}}}}'
    try:
        result = subprocess.run(
            [
                docker,
                "ps",
                "--all",
                "--filter",
                f"label={COMPOSE_DIR_LABEL}",
                "--format",
                fmt,
            ],
            capture_output=True,
            text=True,
            timeout=DOCKER_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.splitlines() if result.returncode == 0 else None


def stop_compose_stacks(
    tree_paths: list[str],
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Start `compose down` for each stack the removed trees left, without waiting.

    Nothing else stops them, and each worktree's stack binds the same host ports, so a
    stack left behind makes the next session's `up` fail. Compose stops a project by
    name with no compose file, so this runs after the tree is gone. Detached because
    stopping a stack can outlast the hook's timeout. --volumes goes with it: the data
    belonged to a tree whose work has landed.
    """
    docker = docker_bin() if tree_paths else ""
    rows = compose_containers(docker) if docker else None
    if not rows:
        return [], []
    stop, keep = compose_stacks(tree_paths, rows)
    started = []
    for project, tree in stop:
        try:
            subprocess.Popen(
                [
                    docker,
                    "compose",
                    "--project-name",
                    project,
                    "down",
                    "--volumes",
                    "--remove-orphans",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError:
            continue
        started.append((project, tree))
    return started, keep


@dataclass
class Tally:
    """What one prune did, for its exit code and its PRUNE-RESULT line.

    Attributes:
        removed: worktrees and orphan directories removed.
        failed: removals and branch deletions that were tried and did not happen.
        in_use: removals skipped because a live process holds the tree.
        branches: branches deleted.
    """

    removed: int = 0
    failed: int = 0
    in_use: int = 0
    branches: int = 0


def prune_trees(repo: str, trees: list[Worktree], tally: Tally, err) -> None:
    """Remove each tree, printing one line per outcome, then stop its compose stacks.

    A failed removal goes to `err`, followed by the lines naming any path another uid
    owns. A tree a live process still uses is named there too but counted apart: one
    session running at a weekly sweep's hour would otherwise fail that sweep's check
    for a week, and a later run removes the tree once its holder exits.
    """
    removed = []
    for tree in trees:
        ok, error = cw.remove(repo, tree)
        if ok:
            removed.append(tree.path)
            tally.removed += 1
            print(f"removed {tree.path} ({tree.branch})")
            log(f"event=worktree_pruned path={tree.path} branch={tree.branch}")
            continue
        if error.startswith(cw.IN_USE):
            tally.in_use += 1
            print(f"kept {tree.path}: {error}; removed once it exits", file=err)
        else:
            tally.failed += 1
            print(f"could not remove {tree.path}: {error}", file=err)
            for line in cw.foreign_owned_advice(tree.path):
                print(line, file=err)
        log(f"event=worktree_prune_failed path={tree.path} error={error}")
    stacks, shared = stop_compose_stacks(removed)
    for project, tree_path in stacks:
        log(f"event=compose_down_started project={project} path={tree_path}")
    if stacks:
        names = ", ".join(project for project, _ in stacks)
        print(f"stopping {len(stacks)} compose stack(s) of removed worktrees: {names}")
    for project, tree_path in shared:
        print(
            f"kept compose project {project} started in {tree_path}: a named project "
            f"may be shared; stop it with `docker compose -p {project} down` once "
            "nothing uses it"
        )


# --- orphan directories ------------------------------------------------------------


def find_orphan_dirs(worktrees_dir: str, tracked: set[str]) -> list[str]:
    """Directories under `.claude/worktrees/` that git no longer registers.

    `git worktree prune` deregisters a tree whose administrative data is gone but
    leaves the directory behind, so these are invisible to `git worktree list`. They
    are judged by their content instead; see `unstored_files`.
    """
    try:
        entries = sorted(Path(worktrees_dir).iterdir())
    except OSError:
        return []
    return [str(e) for e in entries if e.is_dir() and str(e) not in tracked]


# How many unstored files a kept orphan's report names before it counts the rest. An
# orphaned full checkout carries a virtualenv of thousands.
UNSTORED_LISTED = 20

# A worktree's `.git` file holds only this line. Its blob is never committed, so no
# ref reaches it, and it names an administrative directory git has already pruned.
GITDIR_POINTER = re.compile(rb"gitdir: [^\n]+\n?")


def _is_gitdir_pointer(file: Path) -> bool:
    """Whether `file` is a worktree's `.git` file holding only its gitdir line."""
    if file.name != ".git":
        return False
    with file.open("rb") as handle:
        head = handle.read(4097)
    return len(head) <= 4096 and GITDIR_POINTER.fullmatch(head) is not None


def unstored_files(repo: str, path: str) -> list[str] | None:
    """Each regular file under `path` whose content no ref reaches, relative to it.

    An empty list means the orphan holds nothing git lacks, so removing it loses
    nothing: it has no regular files, or every one's content is a blob some ref
    reaches, under any path. None means a walk or a git call failed, so nothing is
    known about it.

    `git hash-object --no-filters --stdin-paths` hashes the content without `-w`, so
    nothing is written to the store. Symlinks and other non-regular entries are
    skipped, because removing one loses no file content. So is the orphan's own `.git`
    gitdir pointer.

    # DECIDED: "stored" means reachable from a ref (`git rev-list --objects --all`),
    # not present in the store. A blob staged in a worktree and never committed is
    # present but unreachable, and the object-store repair at the same sweep's tail
    # prunes unreachable objects after a day; the orphan would have been its last copy.

    # DECIDED: a gitignored file counts like any other, so a virtualenv or a cache
    # keeps its orphan. Exempting ignored paths would also delete an untracked
    # credentials file or a local note, while a kept orphan costs only a hand removal.
    """
    failed: list[OSError] = []
    files = []
    for top, _, names in os.walk(path, onerror=failed.append):
        for name in names:
            file = Path(top) / name
            try:
                if stat.S_ISREG(file.lstat().st_mode) and not (
                    Path(top) == Path(path) and _is_gitdir_pointer(file)
                ):
                    files.append(file)
            except OSError as exc:
                failed.append(exc)
    if failed:
        return None
    # --stdin-paths reads one path per line, so a name holding a newline cannot be
    # hashed. It counts as unstored.
    unstored = [f for f in files if "\n" in str(f)]
    hashable = [str(f) for f in files if "\n" not in str(f)]
    if hashable:
        hashed = git(
            "hash-object",
            "--no-filters",
            "--stdin-paths",
            cwd=repo,
            stdin="".join(f"{line}\n" for line in hashable),
        )
        shas = hashed.stdout.splitlines()
        listed = git("rev-list", "--objects", "--all", cwd=repo)
        if hashed.returncode != 0 or len(shas) != len(hashable):
            return None
        if listed.returncode != 0:
            return None
        reachable = {line.split(" ", 1)[0] for line in listed.stdout.splitlines()}
        unstored += [
            Path(f)
            for f, sha in zip(hashable, shas, strict=True)
            if sha not in reachable
        ]
    return sorted(str(f.relative_to(path)) for f in unstored)


def orphan_verdicts(repo: str) -> list[tuple[str, list[str] | None]]:
    """(path, unstored_files) for every orphan directory under the worktrees dir."""
    tracked = {tree.path for tree in registered(repo)}
    return [
        (path, unstored_files(repo, path))
        for path in find_orphan_dirs(str(Path(repo) / ".claude" / "worktrees"), tracked)
    ]


def orphan_report(path: str, unstored: list[str] | None) -> list[str]:
    """The long report's lines for one orphan, by what `unstored_files` found in it."""
    head = f"[{ORPHAN:9}] {path}"
    if unstored == []:
        return [head, "            holds nothing git lacks — `--prune` removes it"]
    if unstored is None:
        # A removal that failed on a foreign-owned path leaves exactly this: git
        # unregisters the tree after the delete fails.
        return [
            head,
            "            could not read every file — check it, then remove by hand",
            *cw.foreign_owned_advice(path),
        ]
    lines = [
        head,
        f"            {len(unstored)} file(s) hold content git never stored — check "
        "them, then remove by hand:",
    ]
    lines += [f"              {name}" for name in unstored[:UNSTORED_LISTED]]
    if len(unstored) > UNSTORED_LISTED:
        lines.append(f"              and {len(unstored) - UNSTORED_LISTED} more")
    return lines


def prune_orphans(paths: list[str], tally: Tally, err) -> None:
    """Delete each orphan directory unless a live process still uses it.

    The caller passes only orphans `unstored_files` found empty. The in-use check is
    the one `claude_worktree.remove` applies to a registered tree.
    """
    for path in paths:
        held = cw.in_use_reason(path)
        if held:
            tally.in_use += 1
            print(f"kept {path}: {held}; removed once it exits", file=err)
            continue
        try:
            shutil.rmtree(path)
        except OSError as exc:
            tally.failed += 1
            print(f"could not remove {path}: {exc}", file=err)
            for line in cw.foreign_owned_advice(path):
                print(line, file=err)
        else:
            tally.removed += 1
            print(f"removed {path}")


# --- branches ----------------------------------------------------------------------

HELD = "a worktree holds it"
UNLANDED = "not landed, or the landed state could not be read"
FRESH = "no commits of its own yet"
REVIEWABLE = "landed by a layer this repo only reports"
REPO_HOLDS = "the repo's branch holds name it"
HOLDS_UNREAD = "the repo's branch holds could not be read"


@dataclass(frozen=True)
class BranchVerdict:
    """What the sweep does with one session branch.

    Attributes:
        branch: the local branch name.
        head: the tip the verdict was reached for.
        delete: whether a prune deletes it.
        reason: `landed by <layer>` for a deletion, else the condition that keeps it.
    """

    branch: str
    head: str
    delete: bool
    reason: str


def session_branches(repo: str, prefixes: tuple[str, ...]) -> dict[str, str]:
    """Every local branch under `prefixes` and its tip SHA, in ref order.

    The prefixes are the outer refusal: a branch outside them is one somebody made by
    hand, and the sweep never touches it however landed it looks.
    """
    lines = git(
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        *(f"refs/heads/{prefix}*" for prefix in prefixes),
        cwd=repo,
    ).stdout.splitlines()
    return dict(line.rsplit(" ", 1) for line in lines)


def held_branches(repo: str) -> set[str]:
    """The branches a worktree has checked out, the primary checkout's among them."""
    return {tree.branch for tree in registered(repo) if tree.branch}


def ancestry_landed_branches(repo: str, base: str) -> set[str]:
    """Every local branch whose tip is an ancestor of `base`, in one git call.

    An empty set on failure, which reads as "nothing settled", the KEEP direction.
    """
    if not base:
        return set()
    result = git("branch", "--merged", base, "--format=%(refname:short)", cwd=repo)
    return set(result.stdout.split()) if result.returncode == 0 else set()


def repo_held_branches(repo: str, command: tuple[str, ...]) -> set[str] | None:
    """The branches the policy's `branch_holds` command prints, or None when unread.

    No command holds nothing. A command that cannot start, runs past five minutes or
    exits non-zero is unread, which keeps every branch the sweep would delete.
    """
    if not command:
        return set()
    try:
        proc = subprocess.run(
            list(command),
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def judge_branches(sweep: Sweep, holds=repo_held_branches) -> list[BranchVerdict]:
    """One verdict per local session branch: the judge a prune deletes branches by.

    A branch is deleted only when all of these hold, read in this order:

    - no worktree holds it, by `git worktree list`;
    - it has moved since it was created, or is past the fresh grace. A branch cut at
      the base's tip may be one whose worktree is still being created;
    - its work is on the base by a layer the policy lets act, by one bulk
      `git branch --merged` and then `Sweep.landed` on the rest;
    - the repo's `branch_holds` command does not name it.

    An answer that could not be read keeps the branch. The command runs only when
    some branch has passed the other conditions.

    `holds` is a test seam.
    """
    held = held_branches(sweep.repo)
    ancestry = ancestry_landed_branches(sweep.repo, sweep.base)
    landed: dict[str, tuple[str, str]] = {}
    verdicts = []
    for branch, head in session_branches(
        sweep.repo, sweep.policy.branch_prefixes
    ).items():
        if branch in held:
            verdicts.append(BranchVerdict(branch, head, False, HELD))
            continue
        if branch in ancestry:
            if cw.is_fresh(sweep.repo, branch):
                verdicts.append(BranchVerdict(branch, head, False, FRESH))
            else:
                landed[branch] = (head, "ancestry")
            continue
        how = sweep.landed(head, branch)
        if how is None:
            verdicts.append(BranchVerdict(branch, head, False, UNLANDED))
        elif how not in sweep.policy.acts:
            verdicts.append(BranchVerdict(branch, head, False, REVIEWABLE))
        else:
            landed[branch] = (head, how)
    named = holds(sweep.repo, sweep.policy.branch_holds) if landed else set()
    for branch, (head, how) in landed.items():
        if named is None:
            verdicts.append(BranchVerdict(branch, head, False, HOLDS_UNREAD))
        elif branch in named:
            verdicts.append(BranchVerdict(branch, head, False, REPO_HOLDS))
        else:
            verdicts.append(BranchVerdict(branch, head, True, f"landed by {how}"))
    return verdicts


def delete_branch(repo: str, branch: str, head: str) -> tuple[bool, str]:
    """Delete one judged branch, `-d` first, `-D` only while it still points at `head`.

    `git branch -d` accepts ancestry only, and against HEAD or the branch's upstream,
    so it refuses every branch that landed by rebase or squash. `-D` throws away git's
    own backstop, so `judge_branches` is the safety: this is never called for a branch
    it has not settled, and the tip is read again here, because a commit made since
    the verdict is work the verdict never saw.
    """
    result = git("branch", "-d", branch, cwd=repo)
    if result.returncode == 0:
        return True, ""
    tip = git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", cwd=repo)
    if tip.stdout.strip() != head:
        return False, f"{branch} moved since it was judged"
    forced = git("branch", "-D", branch, cwd=repo)
    return forced.returncode == 0, forced.stderr.strip()


def sweep_branches(sweep: Sweep, tally: Tally, err) -> list[BranchVerdict]:
    """Judge the session branches and delete the settled ones, one line per outcome.

    Called AFTER the worktree removals, because each one frees a branch: a list taken
    before them names none of those, and the sweep would leave its own leavings for
    the next run instead of converging in one pass.

    Returns:
        Every verdict, so the caller can report the branches kept for review.
    """
    verdicts = judge_branches(sweep)
    unread = sum(v.reason == HOLDS_UNREAD for v in verdicts)
    if unread:
        print(f"kept {unread} landed branch(es): {HOLDS_UNREAD}", file=err)
    for verdict in verdicts:
        if not verdict.delete:
            continue
        ok, error = delete_branch(sweep.repo, verdict.branch, verdict.head)
        if ok:
            tally.branches += 1
            print(f"deleted {verdict.branch}")
            log(f"event=branch_deleted branch={verdict.branch}")
        else:
            tally.failed += 1
            print(f"could not delete {verdict.branch}: {error}", file=err)
    return verdicts


def _count_line(states: list[str]) -> str:
    """`2 a, 1 b` for a list of state strings, in first-seen order."""
    counts: dict[str, int] = {}
    for state in states:
        counts[state] = counts.get(state, 0) + 1
    return ", ".join(f"{n} {state}" for state, n in counts.items())


def _review_count(verdicts: list[BranchVerdict]) -> str | None:
    """The one line that stands for every branch kept for review, or None.

    Counted, never listed: nothing clears these on its own, and a row per branch at
    every session start once printed 51,010 bytes.
    """
    count = sum(v.reason == REVIEWABLE for v in verdicts)
    if not count:
        return None
    return (
        f"{count} landed-looking branch(es) with no worktree; "
        f"`{COMMAND} --check --all` lists them"
    )


def check_sweep(sweep: Sweep, show_all: bool) -> int:
    """Print what the branch sweep would delete and why, and count what it keeps."""
    # Deletions first, so each count line leads with them.
    verdicts = sorted(judge_branches(sweep), key=lambda v: not v.delete)

    def state(verdict: BranchVerdict) -> str:
        verb = "would be deleted" if verdict.delete else "kept"
        return f"{verb} ({verdict.reason})"

    hidden = any(not v.delete for v in verdicts) and not show_all
    hint = "; --all lists the kept" if hidden else ""
    print(
        f"{len(verdicts)} session branch(es): "
        f"{_count_line([state(v) for v in verdicts])}{hint}"
    )
    for prefix in sweep.policy.branch_prefixes:
        mine = [state(v) for v in verdicts if v.branch.startswith(prefix)]
        print(f"{prefix}*: {_count_line(mine)}")
    groups: dict[str, list[str]] = {}
    for verdict in verdicts:
        if verdict.delete or show_all:
            groups.setdefault(state(verdict), []).append(verdict.branch)
    for heading, names in groups.items():
        print(f"{heading}:")
        for name in names:
            print(f"  {name}")
    return OK


def check(sweep: Sweep, branch: str) -> int:
    """Print one branch's landed or unlanded verdict and the layer that decided it.

    The layer is named whatever the policy lets act: this answers "does this branch
    still hold unlanded work", not "would the sweep delete it".
    """
    head = git(
        "rev-parse", "--verify", "--quiet", f"{branch}^{{commit}}", cwd=sweep.repo
    )
    if head.returncode != 0:
        print(f"no such branch or commit: {branch}", file=sys.stderr)
        return USAGE_ERROR
    layer = (
        cw.merged_layer(sweep.repo, head.stdout.strip(), branch, sweep.base)
        if sweep.base
        else None
    )
    if layer is None:
        print(f"{branch}: unlanded")
        return FAILED
    print(f"{branch}: landed ({layer})")
    return OK


# --- the three reports, and the prune ------------------------------------------------


def survey_report(
    sweep: Sweep, surveyed: list[tuple[str, Worktree, str]], show_all: bool
) -> list[str]:
    """The long report's worktree lines.

    A kept worktree is counted, not listed, because it asks nothing of the reader.
    `show_all` lists it as well.
    """
    lines, kept = [], 0
    for verdict, tree, reason in surveyed:
        if verdict != KEEP or show_all:
            name = sweep.label(tree.path, tree.path)
            lines.append(f"[{verdict:9}] {name}\n            {reason}")
        else:
            kept += 1
    if kept:
        lines.append(f"{kept} worktree(s) kept; --all lists them")
    return lines


def prune(
    sweep: Sweep, removable: list[Worktree], orphans: list[str] | None, err
) -> tuple[Tally, list[BranchVerdict]]:
    """Remove the trees, then the orphans, then the branches the removals freed.

    Args:
        sweep: the run.
        removable: the trees `survey` found REMOVABLE.
        orphans: the orphan directories that hold nothing git lacks, or None for a
            sweep that does not look at orphans or repair the object store.
        err: where a line about something kept or failed goes.
    """
    tally = Tally()
    prune_trees(sweep.repo, removable, tally, err)
    if orphans is not None:
        prune_orphans(orphans, tally, err)
        for line in cw.repair_object_store(sweep.repo):
            print(line)
    verdicts = sweep_branches(sweep, tally, err)
    tips = git("for-each-ref", "--format=%(objectname)", "refs/heads/", cwd=sweep.repo)
    cw.drop_dead_verdicts(
        sweep.repo,
        set(tips.stdout.split()) | {tree.head for tree in registered(sweep.repo)},
    )
    return tally, verdicts


def print_review(surveyed, verdicts: list[BranchVerdict], trees: bool) -> None:
    """Say what a prune kept for a person to settle: each tree, then the branch count.

    These are the cases nothing clears on its own, so a prune that said nothing about
    them would leave them invisible.

    Args:
        surveyed: `survey`'s rows.
        verdicts: `judge_branches`' rows.
        trees: whether to name each REVIEW tree. The long report already has.
    """
    for verdict, tree, reason in surveyed if trees else []:
        if verdict == REVIEW:
            print(f"kept {tree.path}: {reason}")
    review = _review_count(verdicts)
    if review:
        print(review)


def full_prune(sweep: Sweep, surveyed, orphans, review_trees: bool) -> int:
    """The `--prune` path: everything the sweep removes, then its PRUNE-RESULT line.

    Args:
        sweep: the run.
        surveyed: `survey`'s rows.
        orphans: `orphan_verdicts`' rows.
        review_trees: `print_review`'s `trees`.
    """
    removable = [tree for verdict, tree, _ in surveyed if verdict == REMOVABLE]
    tally, verdicts = prune(
        sweep,
        removable,
        [path for path, unstored in orphans if unstored == []],
        sys.stderr,
    )
    print_review(surveyed, verdicts, review_trees)
    # One terminal line a caller reads by field name; a new field goes at the end.
    print(
        f"PRUNE-RESULT: removed={tally.removed} failed={tally.failed} "
        f"in_use={tally.in_use} branches={tally.branches}"
    )
    return FAILED if tally.failed else OK


def long_report(sweep: Sweep, show_all: bool, do_prune: bool) -> int:
    """The default report, and the long form of `--prune`."""
    orphans = orphan_verdicts(sweep.repo)
    for path, unstored in orphans:
        for line in orphan_report(path, unstored):
            print(line)
    empty_orphans = [path for path, unstored in orphans if unstored == []]
    surveyed = survey(sweep)
    for line in survey_report(sweep, surveyed, show_all):
        print(line)
    removable = sum(verdict == REMOVABLE for verdict, _, _ in surveyed)
    vanished = sum(verdict == VANISHED for verdict, _, _ in surveyed)
    if do_prune:
        return full_prune(sweep, surveyed, orphans, review_trees=False)
    # The report names each branch, so it pays the per-branch check whether or not
    # anything is about to be deleted: a report that disagreed with what `--prune`
    # then removed would be worse than a slow one.
    verdicts = judge_branches(sweep)
    stale = [v for v in verdicts if v.delete]
    for verdict in stale:
        print(
            f"[{STALE:9}] {verdict.branch}\n            no worktree, {verdict.reason}"
        )
    review = _review_count(verdicts)
    if review:
        print(review)
    if not (removable or stale or vanished or empty_orphans):
        print("\nnothing to remove")
        return OK
    print(
        f"\n{removable} worktree(s), {len(empty_orphans)} orphan dir(s), "
        f"{len(stale)} branch(es) and {vanished} vanished registration(s) removable "
        "— re-run with --prune to remove"
    )
    return OK


def brief_report(sweep: Sweep) -> int:
    """One line per removable worktree; silent when there is nothing to remove.

    For a session banner, which prints nothing on a healthy day and has to stay cheap.
    The branch count is the bulk ancestry layer alone, two git calls and no network:
    it undercounts a branch that landed by rebase or squash, and counts one the
    repo's holds would keep. That is the right trade for a line whose job is to say
    there is something to sweep.
    """
    removable = [
        (tree, reason)
        for verdict, tree, reason in survey(sweep)
        if verdict == REMOVABLE
    ]
    held = held_branches(sweep.repo)
    ancestry = ancestry_landed_branches(sweep.repo, sweep.base)
    stale = [
        branch
        for branch in session_branches(sweep.repo, sweep.policy.branch_prefixes)
        if branch not in held and branch in ancestry
    ]
    if removable:
        print(f"WARN: {len(removable)} merged worktree(s) can be removed:")
        for tree, reason in removable:
            print(f"  {sweep.label(Path(tree.path).name, tree.path)} — {reason}")
    if stale:
        print(f"WARN: {len(stale)} orphan session branch(es) already on {sweep.base}")
    if removable or stale:
        print(f"  → {COMMAND} --prune")
    return OK


def hook_sweep(sweep: Sweep) -> int:
    """SessionStart sweep: remove, delete, and say only what changed or needs a look.

    Everything goes to stdout, the one stream a SessionStart hook's reader sees.
    """
    surveyed = survey(sweep)
    removable = [tree for verdict, tree, _ in surveyed if verdict == REMOVABLE]
    _, verdicts = prune(sweep, removable, None, sys.stdout)
    print_review(surveyed, verdicts, trees=True)
    return OK


def main(argv: list[str] | None = None) -> int:
    """Run the pruner; the module docstring has the modes and the exit codes."""
    parser = argparse.ArgumentParser(
        prog="prune-worktrees.py",
        description="Report and remove merged Claude session worktrees.",
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help=(
            "remove the worktrees reported as removable, the orphan directories that "
            "hold nothing git lacks and the landed session branches, then repair the "
            "object store (default: report only)"
        ),
    )
    parser.add_argument(
        "--brief",
        action="store_true",
        help=(
            "shorten the report to one line per removable worktree, silent when "
            "clean; combines with --prune, which still removes them"
        ),
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help=(
            "in the long report, list the kept worktrees too; with a bare --check, "
            "list the kept branches too"
        ),
    )
    parser.add_argument(
        "--check",
        metavar="BRANCH",
        nargs="?",
        const="",
        help=(
            "alone, print what the branch sweep would delete and why. With BRANCH, "
            "print whether its work is on the default branch and the layer that "
            "decided it; exit 0 landed, 1 unlanded, 64 for an unknown branch. "
            "Reads only"
        ),
    )
    parser.add_argument(
        "--gc",
        action="store_true",
        help="run the object-store repair alone, without touching any worktree",
    )
    parser.add_argument(
        "--hook",
        action="store_true",
        help="run as the SessionStart hook: a bounded sweep that always exits 0",
    )
    parser.add_argument(
        "--require",
        metavar="N",
        type=int,
        default=0,
        help=(
            f"exit 78 unless this copy's interface is at least N (it is {cw.INTERFACE})"
        ),
    )
    args = parser.parse_args(argv)

    if args.require > cw.INTERFACE:
        print(
            f"this pruner is interface {cw.INTERFACE} and the caller needs "
            f"{args.require}: `chezmoi apply` deploys the copy it was written for",
            file=sys.stderr,
        )
        return CONFIG_ERROR

    if args.hook and os.environ.get("CLAUDE_WORKTREE_AUTOPRUNE") == "0":
        print("worktree autoprune disabled (CLAUDE_WORKTREE_AUTOPRUNE=0)")
        return OK

    repo = cw.primary_checkout()
    if repo is None:
        # Nothing worth saying at session start or in a banner.
        if args.hook or (args.brief and not args.prune):
            return OK
        print("not inside a git checkout", file=sys.stderr)
        return USAGE_ERROR if args.check is not None else FAILED

    if args.gc:
        for line in cw.repair_object_store(repo):
            print(line)
        return OK

    try:
        policy = read_policy(repo)
    except PolicyError as exc:
        # Refused in every mode: a sweep that guessed at a policy it could not read
        # would be guessing what it may delete.
        message = f"{Path(repo) / POLICY_FILE}: {exc}; nothing was pruned"
        print(message, file=sys.stdout if args.hook else sys.stderr)
        return OK if args.hook else CONFIG_ERROR

    if args.hook and not policy.session_start:
        return OK

    common_dir = Path(repo) / ".git"
    if args.hook and not take_prune_lock(common_dir):
        # Silent: the sweep that holds the lock does the same work.
        return OK
    if args.prune and not take_prune_lock(common_dir, LOCK_WAIT_S):
        print(
            f"another sweep held {common_dir / PRUNE_LOCK} for {LOCK_WAIT_S:.0f}s; "
            "nothing was pruned",
            file=sys.stderr,
        )
        return LOCK_BUSY

    sweep = Sweep(
        repo=repo,
        base=cw.default_ref(repo) or "",
        policy=policy,
        forge=budgeted_forge(FORGE_BUDGET_S) if args.hook else cw.forge_says_landed,
        ask_unflagged=not args.hook,
        current=session_dirs(read_event=args.hook),
    )

    if args.hook:
        return hook_sweep(sweep)
    if args.check is not None:
        return check(sweep, args.check) if args.check else check_sweep(sweep, args.all)
    if args.brief and args.prune:
        orphans = orphan_verdicts(repo)
        for path, unstored in orphans:
            if unstored:
                print(f"kept orphan {path}: {len(unstored)} file(s) git never stored")
        return full_prune(sweep, survey(sweep), orphans, review_trees=True)
    if args.brief:
        return brief_report(sweep)
    return long_report(sweep, args.all, args.prune)


if __name__ == "__main__":
    sys.exit(main())
