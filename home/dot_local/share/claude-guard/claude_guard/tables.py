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
# newline, vertical tab, form feed and carriage return — in the C locale. A bash line
# written as a `%%` pattern or a sed `[[:space:]]` class means THIS set, not IFS. The two
# are not interchangeable in either direction — `_OPTION_WORD` ported sed's `[^[:space:]]+`
# as `[^{WS}]+` in fix round 4 and turned a narrow complement into a broad one, so
# `tee -a\rfile` stripped to bare `tee` and the write refusal never fired. A regex that
# ports a `[[:space:]]` construct reads off this constant; one that ports IFS reads `WS`.
#
# DECIDED (#512): the bash this ports ran under `en_US.UTF-8`, where glibc's `[[:space:]]`
# also admits the Unicode spaces below. Measured on daniel-box 2026-09-18 with
# `LC_ALL=en_US.UTF-8 bash -c '[[ $s =~ ^[[:space:]]$ ]]'` over 22 candidates: yes for
# U+1680, U+2000–U+2006, U+2008–U+200A, U+2028, U+2029, U+205F, U+3000; no for U+0085,
# U+00A0, U+180E, U+2007, U+200B, U+202F, U+FEFF (the non-breaking and zero-width ones).
# This is NOT Python's `str.isspace()`, which admits all of U+0085/00A0/2007/202F as well —
# the literal is the port, the method is not. Widening the class narrows what the judge
# allows (`tee -a　file` now keeps `file` past the option strip and refuses), which the
# one-sided replay gate cannot see; a 28-day otelq census found the only commands carrying
# one of these characters were claude-guard's own probes, so nothing organic moves.
POSIX_SPACE = " \t\n\v\f\r              　"

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

# allow-readonly-remote.sh:157-164. The flat, no-subcommand verbs that are read-only under
# ANY argument on BOTH sides of the ssh boundary: `REMOTE_READONLY_VERBS` below judges the
# far shell's verb, and the server repo's local `TIER1` (`.claude/hooks/_readonly_tables.py`)
# reads this same set, each extending it with what is read-only on its side only. One home,
# so a name added here widens both by design — and a name that is read-only only over ssh
# (`_REMOTE_ONLY`) cannot reach the local table by accident. Until server #2078 `TIER1` was
# derived from `REMOTE_READONLY_VERBS` itself, so every remote addition widened local
# auto-approve on the next `chezmoi apply` with no edit and no review on that side.
#
# ip/docker/systemctl are nested sub-tables dispatched beside the check that reads them
# (remote.py), not flat names here — each takes a subcommand argument this table can't
# express. env/printenv are deliberately absent (:149-151): they print every exported
# variable, including API tokens. A verb that reads under most arguments but writes under a
# few (`journalctl`, `dmesg`, `ss`, `rg`, `sensors`) is a `remote_guards.GUARDS` entry, not a
# name here: the table wins in `remote_argv_readonly`, so a guard on a bare-listed verb is
# dead code.
READONLY_BASE: frozenset[str] = frozenset(
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
        "vmstat",
        "iostat",
        "w",
        "who",
        "last",
        "lscpu",
        "lsblk",
        "lsof",
        "lsmod",
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
        "netstat",
        "ping",
        "ping6",
        "dig",
        "host",
        "nslookup",
        "traceroute",
        "tracepath",
        # DECIDED (server #1898): the guard-free half of the server repo's TIER1, so the
        # judge and `auto-approve-readonly.py` agree on every verb that is read-only under
        # ANY argument. Measured 2026-09-18: TIER1 held 32 names this table lacked. `cd`
        # and `false` are meaningless over ssh and stay out; `printenv` stays out for the
        # reason above. The rest are here. NOT moved: the verbs TIER1 reaches only through
        # a per-command guard function (`git`, `sed`, `awk`, `find`, `sort`, `uniq`,
        # `apt`, `dpkg`, `crontab`, `pipx`, ...) — a guarded verb moves only WITH its
        # guard, ported into checks/remote_guards.py, because the replay gate cannot see
        # a remote fail-open (4 of 1058 prompted records touch ssh).
        "apt-cache",
        "b2sum",
        "blkid",
        "column",
        "comm",
        "dpkg-query",
        "findmnt",
        "fold",
        "getconf",
        "groups",
        "hexdump",
        "lastlog",
        "locale",
        "lsattr",
        "lsb_release",
        "lspci",
        "lsusb",
        "mailq",
        "mpstat",
        "nl",
        "nproc",
        "rev",
        "sar",
        "seq",
        "sha512sum",
        "strings",
        "tac",
        "zcat",
        "zgrep",
    }
)

# Read-only over ssh, and kept out of `READONLY_BASE` because the server repo admits neither
# locally (server #2052). Each carries its reason so a later tidy-up does not fold it back.
_REMOTE_ONLY: frozenset[str] = frozenset(
    {
        # Interactive: under Claude's Bash tool it never returns, so the server admits it
        # nowhere. Over ssh with no tty it exits at once, which is harmless.
        "htop",
        # Query-only behind `_nvidia_smi_readonly`, an inline arm of `readonly_remote_safe`
        # that runs before the table. No host in the homelab fleet has NVIDIA hardware, so
        # the server ports no guard for it; it moves into `READONLY_BASE` only with one.
        "nvidia-smi",
    }
)

REMOTE_READONLY_VERBS: frozenset[str] = READONLY_BASE | _REMOTE_ONLY

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
