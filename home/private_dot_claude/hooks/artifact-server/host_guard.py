"""Host and Origin checks that keep a DNS-rebound page from reading this server.

A page on another site can point its own hostname at 127.0.0.1 and then read anything a
loopback server answers, because the browser treats the response as same-origin with that
page. The browser still sends the attacker's hostname in `Host`, so refusing every request
whose `Host` is not one this server answers to closes the hole.

The rules are a port of pr-dash's `src/guard.ts` (`canonicalHost`, `originHost`,
`checkHost`). The two guards share their test cases through
tests/fixtures/host-guard-vectors.json, so a rule changed in one and not the other fails a
suite. pr-dash compares against one expected host; this module takes a list of allowed
origins, so a server behind a reverse proxy can answer to its public name as well. An
origin list of exactly `http://<host>` is the same rule as pr-dash's expected host `<host>`.

Typical usage example:

    allowed = parse_allowed_origins("http://127.0.0.1:8181")
    reason = check_host(handler.headers, allowed)
    if reason is not None:
        ...  # refuse with 403
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

# The scheme and authority of an allowed origin, compared after canonical_host.
Allowed = tuple[str, str]

# Exactly `<scheme>://<authority>`: no path, no query, no trailing slash, no uppercase
# scheme. A browser always sends Origin in this shape, so anything else is forged or
# malformed and is refused rather than parsed leniently. `[^/]+` captures a userinfo trick
# such as `http://127.0.0.1:8181@evil.com` whole, so it is compared as one opaque string and
# never equals a clean allowed authority. pr-dash accepts only `http`; https is accepted
# here only when an allowed origin names it.
ORIGIN_PATTERN = re.compile(r"^(https?)://([^/]+)$")


def canonical_host(host: str) -> str:
    """Rewrites `localhost` and `localhost:<port>` to the 127.0.0.1 spelling.

    Both name the same loopback interface. The rewrite is literal and whole-label, so
    `localhost.evil.com` and `notlocalhost:8181` are left as they are and still fail the
    comparison. Nothing else is normalized: no case-folding, and no other alias.
    """
    if host == "localhost":
        return "127.0.0.1"
    if host.startswith("localhost:"):
        return "127.0.0.1" + host[len("localhost") :]
    return host


def origin_host(origin: str) -> Allowed | None:
    """Returns the (scheme, authority) of a well-formed Origin, or None for any other shape."""
    match = ORIGIN_PATTERN.match(origin)
    if match is None:
        return None
    return match.group(1), match.group(2)


def parse_allowed_origins(value: str) -> list[Allowed]:
    """Parses a comma-separated list of origins into canonical (scheme, authority) pairs.

    Args:
        value: Origins such as `http://127.0.0.1:8181,https://artifacts.example.com`.
            Blank entries are skipped.

    Returns:
        One pair per entry, with the authority passed through canonical_host.

    Raises:
        ValueError: An entry is not exactly `http://<authority>` or `https://<authority>`,
            or the list names no origin at all.
    """
    allowed = []
    for entry in value.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parsed = origin_host(entry)
        if parsed is None:
            raise ValueError(f"not an origin of the form http(s)://<host>: {entry!r}")
        allowed.append((parsed[0], canonical_host(parsed[1])))
    if not allowed:
        raise ValueError("no allowed origins configured")
    return allowed


def check_host(headers: Mapping[str, str], allowed: Sequence[Allowed]) -> str | None:
    """Checks one request's Host and Origin against the allowed origins.

    `Host` must be the authority of an allowed origin. An absent or empty `Host` is
    refused: HTTP/1.1 requires it, and there is nothing to compare without it. `Origin`,
    when present, must equal an allowed origin, scheme included. An absent `Origin` is
    accepted, because same-origin navigations and plain GETs omit it.

    Args:
        headers: The request headers. A mapping that returns the first of repeated
            headers, such as `http.client.HTTPMessage`, matches pr-dash's handling.
        allowed: Pairs from parse_allowed_origins. An empty list refuses every request.

    Returns:
        None when the request may be served, otherwise the reason it is refused.
    """
    host = headers.get("Host")
    authorities = {authority for _, authority in allowed}
    if not host or canonical_host(host) not in authorities:
        return f"unexpected Host: {host}"

    origin = headers.get("Origin")
    if origin is not None:
        parsed = origin_host(origin)
        if parsed is None or (parsed[0], canonical_host(parsed[1])) not in allowed:
            return f"cross-origin request from {origin}"
    return None
