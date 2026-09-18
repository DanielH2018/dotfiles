"""TRUSTED_SSH_HOSTS, REMOTE_READONLY_VERBS, SECRET_PATH_RE — the three tables the remote
check reads. Ported from allow-daniel-server.sh and allow-readonly-remote.sh; no behaviour
here, just the data the checks in a later slice will read.
"""

from claude_guard.tables import CURL_HOSTS, REMOTE_READONLY_VERBS, SECRET_PATH_RE, TRUSTED_SSH_HOSTS

# allow-daniel-server.sh:93. Both hosts that case arm names.
TRUSTED_SSH_HOSTS_MUST_CONTAIN = frozenset({"daniel-server", "daniel-pi"})

# allow-readonly-remote.sh:157-164. A representative slice: a bare verb, a hardware-inspection
# verb, and a log-reading verb — not the whole 68-entry list, which would just restate it.
REMOTE_READONLY_VERBS_MUST_CONTAIN = frozenset(
    {"uptime", "journalctl", "nvidia-smi", "dpkg-query", "sar", "zgrep"}  # server #1898 members
)
REMOTE_READONLY_VERBS_MUST_NOT_CONTAIN = frozenset(
    # server #1898: TIER1 names that stay out — meaningless over ssh, or read-only only
    # behind a guard the package does not carry.
    {"cd", "false", "sed", "awk", "find", "sort", "uniq", "git", "apt", "dpkg", "crontab", "pipx"}
)


def test_trusted_ssh_hosts_contains_both_hosts():
    assert TRUSTED_SSH_HOSTS_MUST_CONTAIN <= TRUSTED_SSH_HOSTS


def test_trusted_ssh_hosts_has_exactly_two_members():
    # Not a count that can silently grow: the two named hosts and nothing else.
    assert TRUSTED_SSH_HOSTS == TRUSTED_SSH_HOSTS_MUST_CONTAIN


def test_trusted_ssh_hosts_is_not_curl_hosts():
    # allow-daniel-server.sh has no host in common with allow-safe-curl.sh's CURL_HOSTS:
    # daniel-box, loopback and localhost are all deliberately absent from the trusted-ssh set.
    # A later "tidy-up" merging the two tables would silently widen ssh trust to daniel-box.
    assert frozenset(CURL_HOSTS) != TRUSTED_SSH_HOSTS
    assert "daniel-box" not in TRUSTED_SSH_HOSTS
    assert not (TRUSTED_SSH_HOSTS & {"localhost", "127.0.0.1", "[::1]"})


def test_remote_readonly_verbs_contains_the_named_members():
    assert REMOTE_READONLY_VERBS_MUST_CONTAIN <= REMOTE_READONLY_VERBS
    assert not (REMOTE_READONLY_VERBS_MUST_NOT_CONTAIN & REMOTE_READONLY_VERBS)


def test_remote_readonly_verbs_excludes_env_and_printenv():
    # allow-readonly-remote.sh:149-151: deliberately absent, they exfiltrate every exported
    # token. A table that silently regained them would reopen that hole.
    assert "env" not in REMOTE_READONLY_VERBS
    assert "printenv" not in REMOTE_READONLY_VERBS


def test_remote_readonly_verbs_excludes_nested_subtable_names():
    # ip/docker/systemctl are dispatched by their own nested sub-tables in remote.py, not
    # flat verb names here — they take a subcommand argument the flat list can't express.
    assert "ip" not in REMOTE_READONLY_VERBS
    assert "docker" not in REMOTE_READONLY_VERBS
    assert "systemctl" not in REMOTE_READONLY_VERBS


def test_secret_path_re_matches_ssh_key_paths_case_insensitively():
    # allow-readonly-remote.sh:133-134: grep -qiE, so the Python side must match case-blind.
    assert SECRET_PATH_RE.search("/home/ubuntu/.SSH/id_ed25519")
    assert SECRET_PATH_RE.search("cat ~/.ssh/config")
    assert SECRET_PATH_RE.search("/proc/1234/environ")
    assert SECRET_PATH_RE.search("terraform.tfstate")


def test_secret_path_re_does_not_match_an_unrelated_path():
    assert SECRET_PATH_RE.search("/var/log/syslog") is None
    assert SECRET_PATH_RE.search("uptime") is None
