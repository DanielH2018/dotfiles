#!/usr/bin/env python3
"""Check a remediation branch's lockfiles against its Dependabot alerts.

An alert does not close until its fix merges, so before a push the lockfile is the
only evidence that a fix landed. For every alert in an `alerts-<repo>.json` file (from
split_alerts.py) this reads the alert's lockfile in a checkout and reports it as
cleared or open:

  * cleared: every locked copy of the package is at or above the patched version, the
    package is absent from the lockfile, or the lockfile itself was deleted
  * open: some locked copy is below the patched version, or the alert has no patch

It then diffs every changed lockfile against a base revision and lists each package
whose major version moved (for 0.x, the minor) and each package the branch added.
Those are what a reviewer must check against the sweep's major-version rule.

Version comparison is numeric segment by segment, with trailing zero segments ignored
(26.2 equals 26.2.0). It does not implement PEP 440 or semver pre-release ordering, so
treat a pre-release version near the patched boundary as needing a manual read.

Usage (from ~/.claude/skills/dependabot-sweep):
    python3 verify_locks.py --alerts alerts-REPO.json --checkout DIR
    python3 verify_locks.py --alerts FILE --checkout DIR --base origin/master

Report-only: the exit code is 0 whatever it finds, and 2 on a usage error.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import tomllib

LOCKFILE = re.compile(r"(\.lock|package-lock\.json|requirements[^/]*\.txt)$")


def norm(name: str) -> str:
    """A package name in PEP 503 normal form; cargo, npm and gem names match it too."""
    return re.sub(r"[-_.]+", "-", name).lower()


def version_key(version: str) -> list[tuple[int, Any]]:
    """A sortable key: numeric segments compare as numbers, trailing zeros dropped."""
    key: list[tuple[int, Any]] = [
        (1, int(p)) if p.isdigit() else (0, p)
        for p in re.findall(r"\d+|[a-z]+", version.lower())
    ]
    while key and key[-1] == (1, 0):
        key.pop()
    return key


def at_least(version: str, floor: str) -> bool:
    return version_key(version) >= version_key(floor)


def major(version: str) -> tuple[str, str]:
    """The part of a version that marks a breaking release; for 0.x, the minor."""
    nums = re.findall(r"\d+", version)
    if not nums:
        return (version, "")
    return (nums[0], nums[1] if nums[0] == "0" and len(nums) > 1 else "")


def parse_lock(text: str, path: str) -> dict[str, set[str]]:
    """Locked versions by normalized package name; a lockfile may hold several."""
    found: dict[str, set[str]] = collections.defaultdict(set)
    if path.endswith("package-lock.json"):
        for key, pkg in json.loads(text).get("packages", {}).items():
            if "node_modules/" in key and "version" in pkg:
                found[norm(key.rsplit("node_modules/", 1)[1])].add(pkg["version"])
    elif path.endswith("Gemfile.lock"):
        for m in re.finditer(r"^    ([A-Za-z0-9_.-]+) \(([^)]+)\)$", text, re.M):
            found[norm(m.group(1))].add(m.group(2).split("-")[0])
    elif re.search(r"requirements[^/]*\.txt$", path):
        for m in re.finditer(
            r"^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?==([^\s;#]+)", text, re.M
        ):
            found[norm(m.group(1))].add(m.group(2))
    elif path.endswith(".lock"):
        # uv.lock, poetry.lock and Cargo.lock all list TOML [[package]] tables.
        for pkg in tomllib.loads(text).get("package", []):
            if "name" in pkg and "version" in pkg:
                found[norm(pkg["name"])].add(pkg["version"])
    return found


def lock_for(manifest: str, checkout: Path) -> str:
    """The lockfile that resolves an alert's manifest path."""
    if manifest.endswith("Cargo.toml"):
        return "Cargo.lock"  # a workspace keeps one lockfile at its root
    if manifest.endswith("pyproject.toml"):
        prefix = manifest[: -len("pyproject.toml")]
        for candidate in ("uv.lock", "poetry.lock"):
            if (checkout / prefix / candidate).exists():
                return prefix + candidate
        return prefix + "uv.lock"
    return manifest


def classify(
    alerts: list[dict[str, Any]], checkout: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Alerts split into (cleared, open), each with its lockfile and locked versions."""
    cache: dict[str, dict[str, set[str]] | None] = {}
    cleared, still_open = [], []
    for alert in alerts:
        lock = lock_for(alert["manifestPath"], checkout)
        if lock not in cache:
            path = checkout / lock
            cache[lock] = (
                parse_lock(path.read_text(encoding="utf-8"), lock)
                if path.exists()
                else None
            )
        locked = cache[lock]
        versions = sorted((locked or {}).get(norm(alert["packageName"]), set()))
        patched = alert.get("patchedVersion")
        if locked is None:
            state = "lockfile deleted"
        elif not versions:
            state = "package absent"
        elif patched and all(at_least(v, patched) for v in versions):
            state = "patched"
        else:
            state = "no patch" if not patched else "below patched"
        row = {**alert, "lockfile": lock, "locked": versions, "state": state}
        (still_open if state in ("below patched", "no patch") else cleared).append(row)
    return cleared, still_open


def git(checkout: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(checkout), *args], capture_output=True, text=True, check=False
    ).stdout


def lock_changes(checkout: Path, base: str) -> list[str]:
    """One line per major move or added package, over lockfiles changed since base."""
    lines = []
    for rel in git(checkout, "diff", "--name-only", f"{base}...HEAD").split():
        if not LOCKFILE.search(rel) or not (checkout / rel).exists():
            continue
        old = parse_lock(git(checkout, "show", f"{base}:{rel}"), rel)
        new = parse_lock((checkout / rel).read_text(encoding="utf-8"), rel)
        for name in sorted(set(old) & set(new)):
            if not {major(v) for v in new[name]} <= {major(v) for v in old[name]}:
                lines.append(
                    f"MAJOR {rel}: {name} {sorted(old[name])} -> {sorted(new[name])}"
                )
        for name in sorted(set(new) - set(old)):
            lines.append(f"ADDED {rel}: {name} {sorted(new[name])}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--alerts",
        type=Path,
        required=True,
        help="alerts-<repo>.json from split_alerts.py",
    )
    parser.add_argument(
        "--checkout",
        type=Path,
        required=True,
        help="the remediation branch's checkout or worktree",
    )
    parser.add_argument(
        "--base",
        default="origin/main",
        help="revision to diff lockfiles against (default origin/main)",
    )
    args = parser.parse_args(argv)

    alerts = json.loads(args.alerts.read_text(encoding="utf-8"))
    cleared, still_open = classify(alerts, args.checkout)
    print(f"cleared {len(cleared)}/{len(alerts)}, open {len(still_open)}")
    for row in sorted(still_open, key=lambda r: r["number"]):
        where = (
            f"#{row['number']} {row['severity']} {row['packageName']} {row['lockfile']}"
        )
        found = f"locked={row['locked']} patched={row.get('patchedVersion')}"
        print(f"  open {where} {found} ({row['state']})")
    for line in lock_changes(args.checkout, args.base):
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
