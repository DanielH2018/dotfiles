"""The shared tables. One home for each; a check imports from here and defines none."""

import re

# K3 (task-8-fix-4-brief.md), the class fix. Bash's own word boundary — after a redirect
# target, a flag, a heredoc delimiter, an fd-dup operand, anywhere IFS field-splits two
# tokens apart — is space and tab. A literal newline is handled by the segmenter before any
# consuming regex runs: a `Segment.text` never carries one. Python's `\s` is wider: it also
# matches `\r`, `\f`, `\v` and Unicode whitespace, none of which is a bash word boundary.
# One definition, imported by every module that means "bash word boundary" — judge.py and
# checks/ansible.py both read it from here, because judge imports ansible and a copy in
# each was the two-literals-that-drift hazard the J1/J2 marker in judge.py names.
WS = " \t"

# The OTHER whitespace class bash uses, and it is wider: POSIX `[[:space:]]` is space, tab,
# newline, vertical tab, form feed and carriage return. A bash line written as a `%%`
# pattern or a sed `[[:space:]]` class means THIS set, not IFS. The two are not
# interchangeable in either direction — `_OPTION_WORD` ported sed's `[^[:space:]]+` as
# `[^{WS}]+` in fix round 4 and turned a narrow complement into a broad one, so
# `tee -a\rfile` stripped to bare `tee` and the write refusal never fired. A regex that
# ports a `[[:space:]]` construct reads off this constant; one that ports IFS reads `WS`.
POSIX_SPACE = " \t\n\v\f\r"

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

# allow-daniel-server.sh:93. NOT CURL_HOSTS: that set also holds daniel-box, loopback and
# localhost. daniel-box is deliberately absent here — this table grants a trusted host the
# WHOLE payload with no verb filter, and daniel-box is where the deployer, secrets and the
# cluster itself live, so it never gets that grant.
TRUSTED_SSH_HOSTS: frozenset[str] = frozenset({"daniel-server", "daniel-pi"})

# allow-readonly-remote.sh:157-164. The flat, no-subcommand verbs. ip/docker/systemctl are
# nested sub-tables dispatched beside the check that reads them (remote.py), not flat names
# here — each takes a subcommand argument this table can't express. env/printenv are
# deliberately absent (:149-151): they print every exported variable, including API tokens.
REMOTE_READONLY_VERBS: frozenset[str] = frozenset(
    {
        "true",
        "uptime",
        "uptimed",
        "whoami",
        "hostname",
        "id",
        "date",
        "uname",
        "arch",
        "pwd",
        "which",
        "type",
        "df",
        "free",
        "du",
        "ps",
        "top",
        "htop",
        "vmstat",
        "iostat",
        "w",
        "who",
        "last",
        "lscpu",
        "lsblk",
        "lsof",
        "lsmod",
        "dmesg",
        "sensors",
        "nvidia-smi",
        "getent",
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "stat",
        "file",
        "tree",
        "readlink",
        "realpath",
        "basename",
        "dirname",
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "echo",
        "printf",
        "cut",
        "tr",
        "jq",
        "od",
        "md5sum",
        "sha1sum",
        "sha256sum",
        "cksum",
        "ss",
        "netstat",
        "ping",
        "ping6",
        "dig",
        "host",
        "nslookup",
        "traceroute",
        "tracepath",
        "journalctl",
    }
)

# allow-readonly-remote.sh:133 (SECRET_RE), matched at :134 with `grep -qiE` — hence
# re.IGNORECASE here. /proc/<pid>/environ dumps a process's exported env unrestricted;
# the rest are credential files a read-only verb (cat, grep, ...) could exfiltrate.
SECRET_PATH_RE: re.Pattern[str] = re.compile(
    r"(\.env|\.ssh(/|\s|$)|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|"
    r"\.gnupg(/|\s|$)|\.netrc|\.pypirc|\.npmrc|/secrets(/|\s|$)|\.git-credentials|"
    r"\.kube/config|\.docker/config\.json|\.config/gh/hosts\.yml|\.config/gcloud/|"
    r"\.config/rclone/rclone\.conf|terraform\.tfstate|\.bash_history|\.claude\.json|"
    r"/etc/shadow|/etc/gshadow|/proc/\S*environ|\.pem($|[^a-z])|\.key($|[^a-z])|"
    r"\.p12($|[^a-z])|\.pfx($|[^a-z]))",
    re.IGNORECASE,
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
