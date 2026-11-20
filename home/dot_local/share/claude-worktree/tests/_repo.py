"""Scratch git repositories for these tests, built with the inherited `GIT_*` gone.

git exports `GIT_DIR` and `GIT_INDEX_FILE` to every hook it runs, and both outrank
`cwd`. A test that commits under a pre-commit or pre-push hook without this scrub
writes the repository the hook fired in. The commit identity travels in the
environment for the same reason: `git config` in a scratch repo can be redirected too.

pytest puts this directory on `sys.path`, so a test imports it by bare name:

    from _repo import commit, git, init_repo
"""

import os
import subprocess
from pathlib import Path


def scrubbed_env(**overrides: str) -> dict[str, str]:
    """The environment minus every `GIT_*` variable, plus a scratch commit identity.

    `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at the null device, so a host's
    commit signing never reaches a scratch commit.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = "t"
    env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = "t@example.invalid"
    env["GIT_CONFIG_GLOBAL"] = env["GIT_CONFIG_SYSTEM"] = os.devnull
    env.update(overrides)
    return env


def git(
    cwd: "str | Path", *args: str, check: bool = True
) -> subprocess.CompletedProcess:
    """Run `git <args>` in `cwd` under `scrubbed_env()`."""
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=scrubbed_env(),
        check=check,
        capture_output=True,
        text=True,
    )


def git_out(cwd: "str | Path", *args: str) -> str:
    """`git(...).stdout` with surrounding whitespace removed."""
    return git(cwd, *args).stdout.strip()


def init_repo(path: Path, branch: str = "master") -> Path:
    """Create a repository at `path`, on `branch`, and return it."""
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", branch)
    return path


def commit(repo: Path, message: str, **files: "str | None") -> str:
    """Write (or delete, for None) each file, commit everything, and return the SHA.

    A keyword name is the path relative to `repo`, so a nested file is passed through
    a dict: `commit(repo, "msg", **{"a/b.txt": "x"})`.
    """
    for name, content in files.items():
        target = repo / name
        if content is None:
            target.unlink()
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)
    return git_out(repo, "rev-parse", "HEAD")


def session_tree(repo: Path, name: str, branch: str, start: str = "HEAD") -> Path:
    """Add a worktree at `<repo>/.claude/worktrees/<name>`, where the sweep looks."""
    path = repo / ".claude" / "worktrees" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    git(repo, "worktree", "add", "-q", "-b", branch, str(path), start)
    return path


def land(repo: Path, ref: str, base: str = "master") -> None:
    """Point `origin/<base>` at `ref`, as if the remote's default branch holds it."""
    git(repo, "update-ref", f"refs/remotes/origin/{base}", ref)


def unreadable_proc(root: Path, pid: int, uid: int, cgroup: str) -> Path:
    """A fake /proc entry the way another uid's process looks.

    `status` and `cgroup` are readable; `cwd` and `environ` are absent, which raises
    OSError the way a refused read does.
    """
    entry = root / str(pid)
    entry.mkdir(parents=True)
    (entry / "status").write_text(f"Name:\tsleep\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n")
    (entry / "cgroup").write_text(f"0::{cgroup}\n")
    return root
