"""The shared tables. One home for each; a check imports from here and defines none.

Slice 2 carries the two tables its checks need. TRUSTED_SSH_HOSTS and REMOTE_READONLY_VERBS
arrive with the remote check in a later slice.
"""

# allow-safe-rm.sh:44-49. An operand must sit strictly BELOW one of these; the root itself
# is refused by the check. `~` is the caller's HOME, expanded by scratch_roots().
SCRATCH_ROOTS: tuple[str, ...] = ("/tmp", "/var/tmp", "~/.claude/jobs", "~/.cache/claude")

# allow-safe-curl.sh:50-57. Exact hosts, matched whole: loopback plus the three machines
# in ~/.ssh/config. The cluster CIDR and domain arms are patterns, not entries, and stay
# in checks/curl.py where the bash keeps them (host_allowed, :168-177).
CURL_HOSTS: tuple[str, ...] = (
    "localhost",
    "127.0.0.1",
    "[::1]",
    "10.0.0.161",  # homelab / daniel-server
    "10.0.0.139",  # daniel-pi
    "10.0.0.215",  # daniel-box
)


def scratch_roots(home: str, tmpdir: str | None = None) -> tuple[str, ...]:
    """SCRATCH_ROOTS with `~` expanded, plus $TMPDIR when it is itself under /tmp.

    allow-safe-rm.sh:50-52: TMPDIR is read but only honoured under /tmp, so exporting it
    as a home path cannot move the boundary. One trailing slash is stripped (${TMPDIR%/}).
    """
    roots = [home + r[1:] if r.startswith("~/") else r for r in SCRATCH_ROOTS]
    if tmpdir and tmpdir.startswith("/tmp/"):
        roots.append(tmpdir.removesuffix("/"))
    return tuple(roots)
