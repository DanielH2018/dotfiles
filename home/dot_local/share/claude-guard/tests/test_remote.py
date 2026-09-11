"""tests/hooks/allow-readonly-remote.test.js, case for case."""

import pytest

from claude_guard.checks.remote import readonly_remote_safe

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


# --- docker inspect/config and systemctl show/cat/show-environment are deliberately
# excluded (:172-174, :187-188) — they print the same secret-dumping shape as `env`. ---


def test_docker_inspect_is_refused():
    assert readonly_remote_safe("hl docker inspect web") is False


def test_systemctl_show_environment_is_refused():
    assert readonly_remote_safe("hl systemctl show-environment") is False
