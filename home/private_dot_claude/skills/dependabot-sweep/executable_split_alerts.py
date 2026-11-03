#!/usr/bin/env python3
"""Split the PR dashboard's open Dependabot alerts into one JSON file per repository.

The dashboard serves every open alert across the watched repositories at `/api/vulns`.
A sweep hands each repository to its own agent, and an agent should read only its own
alerts: the full payload runs to a quarter of a megabyte, and a brief that names it
makes every agent read all of it. This writes `alerts-<repo>.json` per repository and
prints a summary table, which is the input the dispatcher plans the fan-out from.

The script refuses a payload the dashboard marks as failed or stale, and one with
partial errors. A sweep planned from a partial list silently skips the repositories
whose fetch failed.

Usage (from ~/.claude/skills/dependabot-sweep):
    python3 split_alerts.py --out DIR
    python3 split_alerts.py --out DIR --exclude airflow
    python3 split_alerts.py --out DIR --input vulns.json

Exit code is 0 when the files were written, and 1 when the payload was refused.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_URL = "http://127.0.0.1:8770/api/vulns"
SEVERITIES = ("critical", "high", "moderate", "low")


def load(url: str, input_path: Path | None) -> dict[str, Any]:
    """The dashboard payload, from a saved file when one is given, else from the URL."""
    if input_path is not None:
        return json.loads(input_path.read_text(encoding="utf-8"))
    with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 -- loopback dashboard
        return json.loads(resp.read().decode("utf-8"))


def refusal(payload: dict[str, Any]) -> str | None:
    """Why the payload cannot be planned from, or None when it is complete and fresh."""
    if payload.get("error"):
        return f"the dashboard reported an error: {payload['error']}"
    if payload.get("stale"):
        stale = payload.get("staleRepos") or "unknown"
        return f"the dashboard data is stale; stale repos: {stale}"
    if payload.get("partialErrors"):
        return f"the dashboard fetch was partial: {payload['partialErrors']}"
    return None


def split(
    alerts: list[dict[str, Any]], exclude: set[str]
) -> dict[str, list[dict[str, Any]]]:
    """Alerts grouped by short repository name, without the excluded repositories."""
    by_repo: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for alert in alerts:
        name = alert["repo"].split("/", 1)[-1]
        if name not in exclude:
            by_repo[name].append(alert)
    return dict(sorted(by_repo.items()))


def summary_row(name: str, alerts: list[dict[str, Any]]) -> str:
    """One markdown table row: severity counts, ecosystems, manifests, unpatched."""
    sev = collections.Counter(a["severity"] for a in alerts)
    ecosystems = sorted({a["ecosystem"] for a in alerts})
    manifests = {a["manifestPath"] for a in alerts}
    no_patch = sum(1 for a in alerts if not a.get("patchedVersion"))
    cells = [name, len(alerts), *(sev.get(s, 0) for s in SEVERITIES)]
    cells += [", ".join(ecosystems), len(manifests), no_patch]
    return "| " + " | ".join(str(c) for c in cells) + " |"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        help="directory to write alerts-<repo>.json into",
    )
    parser.add_argument(
        "--url", default=DEFAULT_URL, help=f"dashboard endpoint (default {DEFAULT_URL})"
    )
    parser.add_argument(
        "--input", type=Path, help="read a saved /api/vulns payload instead of fetching"
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="short repo name to leave out; repeatable",
    )
    args = parser.parse_args(argv)

    payload = load(args.url, args.input)
    reason = refusal(payload)
    if reason:
        print(f"split_alerts: refusing to split: {reason}", file=sys.stderr)
        return 1

    groups = split(payload.get("alerts", []), set(args.exclude))
    args.out.mkdir(parents=True, exist_ok=True)
    headers = ["repo", "alerts", *SEVERITIES, "ecosystems", "manifests", "no patch"]
    print("| " + " | ".join(headers) + " |")
    print("|" + "---|" * len(headers))
    for name, alerts in groups.items():
        (args.out / f"alerts-{name}.json").write_text(
            json.dumps(alerts, indent=1) + "\n", encoding="utf-8"
        )
        print(summary_row(name, alerts))
    total = sum(len(a) for a in groups.values())
    fetched = payload.get("fetchedAt", "unknown")
    print(f"\n{total} alerts in {len(groups)} repos written to {args.out}")
    print(f"dashboard data fetched at {fetched}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
