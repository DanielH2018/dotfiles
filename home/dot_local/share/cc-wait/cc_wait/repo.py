"""A repo's own sources: tracked executables under `.claude/wait-sources/`.

A probe is an executable of any language. `<probe> --describe <args>` prints the JSON that
`cc_wait.source.description_from_json` reads, and `<probe> <args>` prints one JSON line with
the state and exits 0. Any other exit is a failed read, which the loop retries.

A repo probe gets the same trust as that repo's `.claude/hooks/`, which already run without a
prompt on every tool call. The one extra condition is that git tracks it, so a file dropped
into the directory cannot run under cc-wait's name. Probes must be read-only; nothing here can
check that.
"""

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from cc_wait.source import (
    Description,
    ReadError,
    Reading,
    SourceError,
    description_from_json,
    reading_from_json,
)

SOURCES_DIR = Path(".claude") / "wait-sources"

# A source name is a path component, so it must not be able to leave the directory.
_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

DESCRIBE_TIMEOUT_S = 10
READ_TIMEOUT_S = 60


def repo_root(cwd: Path) -> Path | None:
    """The git toplevel containing `cwd`, or None outside a repository."""
    try:
        out = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return None
    return Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None


def tracked_probes(root: Path) -> list[str]:
    """The names of the probes git tracks under `root`'s `.claude/wait-sources/`."""
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "--", str(SOURCES_DIR)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    names = []
    for line in out.stdout.splitlines():
        rel = Path(line)
        if rel.parent == SOURCES_DIR and _NAME.match(rel.name):
            names.append(rel.name)
    return sorted(names)


def _run(cmd: list[str], cwd: Path, timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False
    )


@dataclass(frozen=True)
class ProbeWait:
    path: Path
    args: tuple[str, ...]
    cwd: Path

    def describe(self) -> Description:
        try:
            out = _run([str(self.path), "--describe", *self.args], self.cwd, DESCRIBE_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SourceError(f"{self.path} --describe did not run: {exc}") from exc
        if out.returncode != 0:
            raise SourceError(
                f"{self.path} --describe exited {out.returncode}: {out.stderr.strip()[-400:]}"
            )
        return description_from_json(out.stdout)

    def read(self) -> Reading:
        try:
            out = _run([str(self.path), *self.args], self.cwd, READ_TIMEOUT_S)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ReadError(f"{self.path} did not run: {exc}") from exc
        if out.returncode != 0:
            raise ReadError(f"{self.path} exited {out.returncode}: {out.stderr.strip()[-400:]}")
        lines = [line for line in out.stdout.splitlines() if line.strip()]
        if not lines:
            raise ReadError(f"{self.path} printed no state")
        return reading_from_json(lines[-1])


@dataclass(frozen=True)
class ProbeSource:
    name: str
    path: Path
    cwd: Path
    summary: str = "this repo's probe"

    def bind(self, args: list[str]) -> ProbeWait:
        return ProbeWait(self.path, tuple(args), self.cwd)


def find(name: str, cwd: Path) -> ProbeSource | None:
    """The repo probe called `name` for a session in `cwd`, or None when there is none.

    Raises:
      SourceError: the probe exists but git does not track it, or it is not executable.
    """
    if not _NAME.match(name):
        return None
    root = repo_root(cwd)
    if root is None:
        return None
    path = root / SOURCES_DIR / name
    if not path.exists():
        return None
    if name not in tracked_probes(root):
        raise SourceError(f"{path} is not tracked by git, so cc-wait will not run it")
    if not path.is_file() or not path.stat().st_mode & 0o111:
        raise SourceError(f"{path} is not an executable file")
    return ProbeSource(name, path, cwd)
