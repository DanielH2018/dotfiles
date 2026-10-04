"""GitHub sources: `gh-pr` (a pull request is merged or closed) and `gh-ci` (a commit's checks).

Both read through the `gh` CLI, so a wait spends the session's authenticated 5,000 requests an
hour, never the anonymous 60 a host shares with everything else that polls GitHub from it.
Both declare `remote`, so cc-wait shares one read per interval among every wait on the same
arguments on this host (`cc_wait.cache`).

`gh-ci` judges every check run on the commit: any failed run fails the wait at once, and the
wait passes only when every run has completed without one. An empty list of check runs is a
commit whose workflows have not registered yet, so it reads as pending, never as passed.
"""

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from cc_wait.source import ArgParser, Description, ReadError, Reading, SourceError

INTERVAL_S = 30.0
GH_TIMEOUT_S = 30

# A check run that completed with one of these failed. `cancelled` is its own state: the run
# will not finish, but it did not fail either, and the caller decides what that means.
FAILED_CONCLUSIONS = frozenset({"failure", "timed_out", "action_required", "startup_failure"})

_GITHUB_REMOTE = re.compile(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

Runner = Callable[..., subprocess.CompletedProcess]


def repo_for(explicit: str | None, cwd: Path, run: Runner = subprocess.run) -> str:
    """`owner/name` from `--repo`, or from the `origin` remote of the repository at `cwd`."""
    if explicit:
        if not _REPO.match(explicit):
            raise SourceError(f"--repo {explicit!r} is not OWNER/NAME")
        return explicit
    out = run(
        ["git", "-C", str(cwd), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    match = _GITHUB_REMOTE.search(out.stdout.strip()) if out.returncode == 0 else None
    if not match:
        raise SourceError("this directory has no GitHub `origin` remote; pass --repo OWNER/NAME")
    return f"{match.group(1)}/{match.group(2)}"


def gh_json(args: list[str], run: Runner = subprocess.run):
    """`gh <args>`'s JSON output, or ReadError when gh fails or prints something else."""
    try:
        out = run(["gh", *args], capture_output=True, text=True, timeout=GH_TIMEOUT_S, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ReadError(f"gh did not run: {exc}") from exc
    if out.returncode != 0:
        raise ReadError(
            f"gh {' '.join(args[:2])} exited {out.returncode}: {out.stderr.strip()[-300:]}"
        )
    try:
        return json.loads(out.stdout)
    except ValueError as exc:
        raise ReadError(f"gh {' '.join(args[:2])} printed no JSON") from exc


@dataclass(frozen=True)
class PrWait:
    repo: str
    number: str
    run: Runner = field(default=subprocess.run, compare=False, repr=False)

    def describe(self) -> Description:
        return Description(terminal={"merged": 0, "closed": 1}, interval_s=INTERVAL_S, remote=True)

    def read(self) -> Reading:
        fields = "state,mergeable,autoMergeRequest"
        data = gh_json(["pr", "view", self.number, "--repo", self.repo, "--json", fields], self.run)
        state = str(data.get("state", "")).lower()
        if state in ("merged", "closed"):
            return Reading(state, f"{self.repo}#{self.number}")
        auto = ", auto-merge armed" if data.get("autoMergeRequest") else ""
        return Reading("open", f"mergeable {str(data.get('mergeable', '?')).lower()}{auto}")


class PrSource:
    name = "gh-pr"
    summary = "a pull request is merged (0) or closed unmerged (1)"

    def bind(self, args: list[str], cwd: Path | None = None) -> PrWait:
        parser = ArgParser(prog="cc-wait gh-pr", add_help=False)
        parser.add_argument("number")
        parser.add_argument("--repo")
        ns = parser.parse_args(args)
        if not ns.number.isdigit():
            parser.error(f"{ns.number!r} is not a pull request number")
        return PrWait(repo_for(ns.repo, cwd or Path.cwd()), ns.number)


@dataclass(frozen=True)
class CiWait:
    repo: str
    ref: str | None
    pr: str | None
    run: Runner = field(default=subprocess.run, compare=False, repr=False)

    def describe(self) -> Description:
        return Description(
            terminal={"passed": 0, "failed": 1, "cancelled": 1},
            interval_s=INTERVAL_S,
            remote=True,
        )

    def _sha(self) -> str:
        if self.ref:
            return self.ref
        # Read every time, so a push to the pull request moves the wait to its new head.
        data = gh_json(
            ["pr", "view", str(self.pr), "--repo", self.repo, "--json", "headRefOid"], self.run
        )
        sha = data.get("headRefOid")
        if not isinstance(sha, str) or not sha:
            raise ReadError(f"{self.repo}#{self.pr} has no head commit")
        return sha

    def read(self) -> Reading:
        sha = self._sha()
        data = gh_json(
            ["api", f"repos/{self.repo}/commits/{sha}/check-runs?per_page=100"], self.run
        )
        runs = data.get("check_runs") if isinstance(data, dict) else None
        if not isinstance(runs, list):
            raise ReadError(f"no check_runs list for {sha[:8]}")
        if not runs:
            return Reading("pending", f"{sha[:8]}: no check runs registered yet")
        failed = [r for r in runs if r.get("conclusion") in FAILED_CONCLUSIONS]
        if failed:
            names = ", ".join(sorted(str(r.get("name")) for r in failed)[:3])
            return Reading("failed", f"{sha[:8]}: {len(failed)} failed: {names}")
        done = [r for r in runs if r.get("status") == "completed"]
        if len(done) < len(runs):
            return Reading("running", f"{sha[:8]}: {len(done)}/{len(runs)} check runs complete")
        cancelled = [r for r in runs if r.get("conclusion") == "cancelled"]
        if cancelled:
            names = ", ".join(sorted(str(r.get("name")) for r in cancelled)[:3])
            return Reading("cancelled", f"{sha[:8]}: {len(cancelled)} cancelled: {names}")
        return Reading("passed", f"{sha[:8]}: {len(runs)} check runs passed")


class CiSource:
    name = "gh-ci"
    summary = "a commit's (or a PR head's) GitHub check runs all pass (0), or one fails (1)"

    def bind(self, args: list[str], cwd: Path | None = None) -> CiWait:
        parser = ArgParser(prog="cc-wait gh-ci", add_help=False)
        parser.add_argument("ref", nargs="?", help="a commit SHA")
        parser.add_argument("--pr", help="follow this pull request's head commit instead")
        parser.add_argument("--repo")
        ns = parser.parse_args(args)
        if (ns.ref is None) == (ns.pr is None):
            parser.error("give a commit SHA or --pr <number>, not both")
        if ns.ref is not None and not re.fullmatch(r"[0-9a-f]{7,40}", ns.ref):
            parser.error(f"{ns.ref!r} is not a commit SHA")
        if ns.pr is not None and not ns.pr.isdigit():
            parser.error(f"--pr {ns.pr!r} is not a pull request number")
        return CiWait(repo_for(ns.repo, cwd or Path.cwd()), ns.ref, ns.pr)
