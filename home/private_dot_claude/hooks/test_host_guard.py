#!/usr/bin/env python3
"""Standalone tests for artifact-server/host_guard.py.

Run: python3 test_host_guard.py

The Host and Origin cases come from tests/fixtures/host-guard-vectors.json, which
pr-dash's tests/guard.test.ts reads too, so the two guards fail together when they
disagree. The checks after them cover what only this guard has: more than one
allowed origin, an https origin, and the parsing of ARTIFACTS_ALLOWED_ORIGINS.
"""

import json
import os
import sys

from _testkit import check, finish

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(
    HERE, "..", "..", "..", "tests", "fixtures", "host-guard-vectors.json"
)
# The cluster's names, as the homelab's ingress route serves them behind Traefik.
CLUSTER = (
    "https://artifacts.daniel-hunter.com,https://artifacts.local.daniel-hunter.com"
)


def headers(host, origin):
    """Build a header mapping, leaving out a header whose value is None."""
    out = {}
    if host is not None:
        out["Host"] = host
    if origin is not None:
        out["Origin"] = origin
    return out


def main():
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(HERE, "artifact-server"))
    from host_guard import check_host, parse_allowed_origins

    with open(VECTORS, encoding="utf-8") as f:
        vectors = json.load(f)["vectors"]
    check("the shared host-guard vectors loaded", len(vectors) > 0)
    for v in vectors:
        allowed = parse_allowed_origins(f"http://{v['expected_host']}")
        reason = check_host(headers(v["host"], v["origin"]), allowed)
        check(v["name"], (reason is None) == v["allow"])

    cluster = parse_allowed_origins(CLUSTER)
    check(
        "the cluster's public name passes with its https Origin",
        check_host(
            headers(
                "artifacts.daniel-hunter.com", "https://artifacts.daniel-hunter.com"
            ),
            cluster,
        )
        is None,
    )
    check(
        "every listed name is accepted, not only the first",
        check_host(headers("artifacts.local.daniel-hunter.com", None), cluster) is None,
    )
    check(
        "an Origin must match by scheme as well as host",
        check_host(
            headers(
                "artifacts.daniel-hunter.com", "http://artifacts.daniel-hunter.com"
            ),
            cluster,
        )
        is not None,
    )
    check(
        "an Origin naming another allowed host is accepted",
        check_host(
            headers(
                "artifacts.daniel-hunter.com",
                "https://artifacts.local.daniel-hunter.com",
            ),
            cluster,
        )
        is None,
    )
    check(
        "an empty allowed list refuses every request",
        check_host(headers("127.0.0.1:8181", None), []) is not None,
    )

    def rejects(value):
        try:
            parse_allowed_origins(value)
        except ValueError:
            return True
        return False

    check("a bare host is not an allowed origin", rejects("127.0.0.1:8181"))
    check("an origin with a path is not an allowed origin", rejects("http://h/x"))
    check("a list of only commas names no origin", rejects(" , ,"))
    check(
        "blank entries around commas are skipped",
        parse_allowed_origins(" http://a:1 ,, https://b ")
        == [("http", "a:1"), ("https", "b")],
    )
    check(
        "a localhost entry is stored as 127.0.0.1",
        parse_allowed_origins("http://localhost:8181") == [("http", "127.0.0.1:8181")],
    )

    finish()


if __name__ == "__main__":
    main()
