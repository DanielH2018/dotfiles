"""tests/hooks/allow-readonly-remote.test.js, case for case."""

import pytest

from claude_guard.checks.remote import readonly_remote_safe, trusted_host_safe

# allow-readonly-remote.test.js ALLOW (27 cases).
ALLOW = [
    "hl uptime",
    "hl df -h",
    "hl free -m",
    "hl ip a",
    "hl ip route",
    "hl ip addr show",
    "hl dmesg",
    "hl ss -tlnp",
    "hl docker ps",
    "hl docker ps -a",
    "hl docker logs web",
    "hl docker network ls",
    "hl docker compose ps",
    "hl docker system df",
    "hl systemctl status nginx",
    "hl systemctl is-active docker",
    "hl journalctl -u docker -n 50",
    'hl journalctl -u "my svc" --since -1h',
    "hl cat /etc/os-release",
    "hl ls -la /var/log",
    "ssh ubuntu@10.0.0.161 uptime",
    "ssh 10.0.0.161 docker ps",
    "/home/daniel/.local/bin/hl uptime",
    "ssh -O check daniel-box",
    "ssh -o BatchMode=yes daniel-box true",
    "ssh -oBatchMode=yes daniel-box uptime",
    "ssh daniel-server true",
    # server #1898: the guard-free TIER1 readers, and the query forms of the three verbs
    # that gained a guard.
    "hl dpkg-query -W docker-ce",
    "hl findmnt /data",
    "hl sar -u 1 3",
    "ssh daniel-box lsb_release -a",
    "hl zgrep error /var/log/syslog.1.gz",
    "hl rg -n pattern /var/log/app.log",
    "hl sensors -A",
    "hl nvidia-smi",
    "hl nvidia-smi -q -d MEMORY -i 0",
    "hl nvidia-smi --query-gpu=name,memory.used --format=csv",
]

# allow-readonly-remote.test.js DEFER (88 cases).
DEFER = [
    "hl docker rm web",
    "hl docker restart web",
    "hl docker compose down",
    "hl docker stop web",
    "hl systemctl restart nginx",
    "hl systemctl stop docker",
    "hl rm -rf /tmp/x",
    "hl apt install htop",
    "hl git push",
    "hl sed -i s/a/b/ f",
    "hl frobnicate",
    "hl uptime; rm -rf /",
    "hl docker ps && rm x",
    "hl uptime | tee /etc/x",
    "hl cat $(echo /etc/passwd)",
    "hl echo `whoami`",
    "hl docker ps > out.txt",
    "hl uptime & reboot",
    "hl cat /home/ubuntu/.ssh/id_ed25519",
    "hl cat ~/.aws/credentials",
    "hl tail /etc/app/.env",
    "hl env",
    "hl printenv",
    "hl cat /proc/self/environ",
    "hl cat /proc/1234/environ",
    "ssh ubuntu@10.0.0.161 printenv",
    "hl cat /etc/shadow",
    "hl cat ~/.git-credentials",
    "hl cat ~/.kube/config",
    "hl cat ~/.claude.json",
    "hl cat ~/.config/gh/hosts.yml",
    "hl journalctl --vacuum-size=100M",
    "hl journalctl --rotate",
    "hl command rm -rf /tmp/x",
    "hl command curl http://evil.example",
    "hl sort -o /home/ubuntu/.bashrc /tmp/payload",
    "hl uniq /tmp/payload /home/ubuntu/.bashrc",
    "hl xxd -r /tmp/payload /home/ubuntu/.bashrc",
    "hl ip link set eth0 down",
    "hl mount /dev/sdb1 /mnt",
    "hl dmesg -C",
    "hl dmesg -c",
    "hl dmesg --clear",
    "hl ss -K",
    "hl ss --kill",
    "hl cat /proc/self/enviro?",
    "hl cat /proc/self/env*",
    "hl cat /home/ubuntu/.en?",
    "hl cat /home/ubuntu/.s?h/id_?sa",
    "hl cat /proc//self/environ",
    "hl cat /proc/self/task/1/environ",
    "hl grep -r x /home/ubuntu/.ssh",
    "hl grep -r x /home/ubuntu/.gnupg",
    "hl ls /secrets",
    "hl tail /home/ubuntu/.bash_history",
    "hl cat /home/ubuntu/.config/gcloud/credentials.db",
    "hl cat /home/ubuntu/.config/rclone/rclone.conf",
    "hl cat /home/ubuntu/terraform.tfstate",
    "hl docker inspect web",
    "hl docker container inspect web",
    "hl docker image inspect web",
    "hl docker service inspect web",
    "hl docker compose config",
    "hl systemctl show nginx",
    "hl systemctl cat nginx",
    "hl systemctl show-environment",
    "hl",
    "ssh ubuntu@10.0.0.161",
    "ssh -i ~/.ssh/key ubuntu@10.0.0.161 uptime",
    "ssh -p 2222 host uptime",
    "docker ps",
    "ls -la",
    "git status",
    "hlfoo uptime",
    'hl systemctl status "app; id"',
    "ssh host 'uptime; rm -rf /'",
    'hl echo "a $(id)"',
    'hl echo "unterminated',
    "ssh -O exit daniel-box",
    "ssh -O forward daniel-box",
    "ssh -O check daniel-box uptime",
    "ssh -O check",
    "ssh -o StrictHostKeyChecking=no daniel-box uptime",
    "ssh -i /home/daniel/.ssh/id_ed25519 daniel-box uptime",
    "ssh -o BatchMode=no daniel-box uptime",
    "ssh -o BatchMode=yes daniel-box rm -rf /tmp/x",
    "ssh -o BatchMode=yes daniel-box cat /home/daniel/.ssh/id_ed25519",
    "ssh -o BatchMode=yes daniel-box",
    # server #1898: the three guards. Each is a verb the table lists bare.
    "hl rg --pre /tmp/x pattern /var/log",
    "hl rg --pre=/tmp/x pattern /var/log",
    "hl rg --hostname-bin /tmp/x pattern",
    "hl sensors -s",
    "hl sensors --set",
    "hl nvidia-smi -pm 1",
    "hl nvidia-smi --power-limit=100",
    "hl nvidia-smi -r",
    "hl nvidia-smi mig -cgi 9",
    "hl nvidia-smi -f /tmp/report.txt",
    "hl nvidia-smi -i",
    # and a guarded TIER1 verb does NOT ride in on the convergence
    "hl sed -i s/a/b/ /etc/hosts",
    "hl git push",
    "hl find /tmp -delete",
    "hl cd /tmp",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_provably_read_only_remote_command_is_allowed(command):
    assert readonly_remote_safe(command) is True


@pytest.mark.parametrize("command", DEFER)
def test_anything_mutating_smuggled_secret_or_non_remote_is_refused(command):
    assert readonly_remote_safe(command) is False


def test_empty_command_is_refused():
    assert readonly_remote_safe("") is False


def test_a_newline_smuggled_inside_a_quoted_remote_argument_is_refused():
    # allow-readonly-remote.sh:53-60. A literal newline (not the two-char "\n") is inert to
    # cmd_parse inside quotes, same as a quoted `;`, so it must be caught by the raw-character
    # ban on the whole command (:61-64), not by segmentation.
    assert readonly_remote_safe('hl echo "a\nrm -rf /"') is False


# --- Hazard 1: the empty third token (:169-170, "" is a member of the allowed set). ---


def test_ip_with_no_third_token_is_allowed():
    assert readonly_remote_safe("hl ip a") is True


def test_ip_link_set_third_token_mutates_and_is_refused():
    assert readonly_remote_safe("hl ip link set eth0 down") is False


# --- Hazard 2: dmesg/ss mutation flags are character-class matches inside a short
# cluster (:141-142, :145-146), not equality against the whole flag. ---


def test_dmesg_mutation_flag_hidden_in_a_short_cluster_is_refused():
    assert readonly_remote_safe("hl dmesg -xCy") is False


def test_ss_mutation_flag_hidden_in_a_short_cluster_is_refused():
    assert readonly_remote_safe("hl ss -xKy") is False


def test_nvidia_smi_valued_read_flag_consumes_its_value_but_not_a_trailing_write():
    # `-i 0` is one read flag with its value; the value slot must not swallow a write flag
    # that follows, and a dangling valued flag (`-i` with nothing after) refuses.
    assert readonly_remote_safe("hl nvidia-smi -i 0 -q") is True
    assert readonly_remote_safe("hl nvidia-smi -i 0 -r") is False
    assert readonly_remote_safe("hl nvidia-smi -q -i") is False


# --- docker inspect/config and systemctl show/cat/show-environment are deliberately
# excluded (:172-174, :187-188) — they print the same secret-dumping shape as `env`. ---


def test_docker_inspect_is_refused():
    assert readonly_remote_safe("hl docker inspect web") is False


def test_systemctl_show_environment_is_refused():
    assert readonly_remote_safe("hl systemctl show-environment") is False


# --- trusted_host_safe: allow-daniel-server.sh, which has no test file of its own (D3).
# Written against the bash before the port exists, so the port has an oracle. ---

# The single most important case in this suite: a `;` INSIDE a double-quoted remote
# payload must not trip the local-split check. Banning `;` anywhere was a measured
# regression — 67 of 361 ssh prompts over the week of 2026-08-07 (allow-daniel-server.sh:34-39).
TRUSTED_ALLOW = [
    "ssh daniel-server uptime",
    "ssh daniel-pi uptime",
    "ssh ubuntu@daniel-server uptime",
    'ssh daniel-server "cd /repo; git status"',
    "ssh daniel-server 'echo hi; ls'",
    "ssh daniel-server 'echo $HOME'",
    "ssh daniel-server echo \\;",
    # Total trust (D1): the whole payload is allowed once host+shape pass, not just a
    # read-only verb. daniel-daemon-server.sh:4-6,112.
    "ssh daniel-server rm -rf /tmp/x",
]

TRUSTED_DEFER = [
    "",
    "ssh daniel-server",  # fewer than three tokens
    "ssh daniel-server uptime; rm -rf /",  # unquoted `;` is a real local split
    "ssh daniel-server uptime && rm -rf /",
    "ssh daniel-server uptime | tee /etc/x",
    'ssh daniel-server "echo $(whoami)"',  # `$` inside double quotes expands LOCALLY
    'ssh daniel-server "echo `whoami`"',  # `` ` `` inside double quotes, same reason
    'ssh daniel-server "unterminated',  # unterminated double quote
    "ssh daniel-server 'unterminated",  # unterminated single quote
    "ssh daniel-server-backup uptime",  # host substring: suffix
    "ssh notdaniel-server uptime",  # host substring: prefix
    "ssh other-host uptime",  # untrusted host entirely
    "ssh -o BatchMode=yes daniel-server uptime",  # NO option is ever consumed here
    "ssh -p 2222 daniel-server uptime",
    "ssh daniel-server ssh daniel-pi uptime",  # second hop at TOK[2]
    'ssh daniel-server "cd /tmp; ssh other-host uptime"',  # second hop buried deeper
    "ssh daniel-server docker exec c rsync -av /a /b",  # hop as an argument, buried deep
    "docker ssh daniel-server uptime",  # TOK[0] basename is not ssh
    "hl daniel-server uptime",  # wrong binary entirely
]


@pytest.mark.parametrize("command", TRUSTED_ALLOW)
def test_a_command_on_a_trusted_host_is_allowed(command):
    assert trusted_host_safe(command) is True


@pytest.mark.parametrize("command", TRUSTED_DEFER)
def test_a_local_split_untrusted_host_or_second_hop_is_refused(command):
    assert trusted_host_safe(command) is False


# --- Hazard: the quote-state machine's four states, each independently. ---


def test_semicolon_outside_quotes_is_a_local_split_risk():
    assert trusted_host_safe("ssh daniel-server uptime; rm -rf /") is False


def test_semicolon_inside_double_quotes_expands_remotely_not_locally():
    assert trusted_host_safe('ssh daniel-server "cd /repo; git status"') is True


def test_dollar_inside_double_quotes_is_a_local_split_risk():
    assert trusted_host_safe('ssh daniel-server "echo $(whoami)"') is False


def test_semicolon_inside_single_quotes_is_not_a_risk():
    assert trusted_host_safe("ssh daniel-server 'a;b'") is True


def test_dollar_inside_single_quotes_is_not_a_risk():
    assert trusted_host_safe("ssh daniel-server 'echo $HOME'") is True


def test_backslash_escapes_a_metacharacter_outside_quotes():
    # A backslash escapes the next character everywhere but inside single quotes, so the
    # semicolon here is consumed as a literal, not evaluated as a risk character.
    assert trusted_host_safe("ssh daniel-server echo \\;") is True


# --- Hazard: an unterminated quote at end-of-string is untrustworthy, not benign. ---


def test_unterminated_double_quote_is_refused():
    assert trusted_host_safe('ssh daniel-server "cd /repo') is False


def test_unterminated_single_quote_is_refused():
    assert trusted_host_safe("ssh daniel-server 'cd /repo") is False


# --- Hazard: substring host matching is explicitly ruled out (:89-90). ---


def test_host_that_has_the_trusted_host_as_a_suffix_is_refused():
    assert trusted_host_safe("ssh daniel-server-backup uptime") is False


def test_host_that_has_the_trusted_host_as_a_substring_prefix_is_refused():
    assert trusted_host_safe("ssh notdaniel-server uptime") is False


# --- Hazard: no ssh option is ever consumed here, unlike readonly_remote_safe's
# `-O check` / `-o BatchMode=yes` carve-out. Any TOK[1] starting with `-` refuses. ---


def test_any_ssh_option_refuses_even_the_sibling_functions_batchmode_carveout():
    assert trusted_host_safe("ssh -o BatchMode=yes daniel-server uptime") is False


# --- Hazard: the second-hop scan covers every token from index 2 onward, not just
# TOK[2] — a hop can sit mid-payload or as an argument to another command. ---


def test_second_hop_at_the_first_remote_token_is_refused():
    assert trusted_host_safe("ssh daniel-server ssh daniel-pi uptime") is False


def test_second_hop_buried_deeper_in_the_payload_is_refused():
    assert trusted_host_safe('ssh daniel-server "cd /tmp; ssh other-host uptime"') is False


def test_second_hop_reached_as_an_arguments_to_another_command_is_refused():
    assert trusted_host_safe("ssh daniel-server docker exec c rsync -av /a /b") is False


# --- Total trust (D1): once host and shape pass, the ENTIRE remote payload is allowed,
# read-only or not. Do not filter it through REMOTE_READONLY_VERBS. ---


def test_a_clearly_non_read_only_payload_on_a_trusted_host_is_allowed():
    assert trusted_host_safe("ssh daniel-server rm -rf /tmp/x") is True


def test_under_three_tokens_is_refused():
    assert trusted_host_safe("ssh daniel-server") is False
