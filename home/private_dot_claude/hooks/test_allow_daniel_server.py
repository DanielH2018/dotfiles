#!/usr/bin/env python3
"""Standalone tests for allow-daniel-server.sh.

Run: python3 test_allow_daniel_server.py

Feeds the hook a PermissionRequest Bash payload on stdin and asserts allow
(structured decision) vs prompt (no output). The hook exists to widen
allow-readonly-remote.sh for the two homelab hosts, so the cases that matter are:
non-read-only commands on daniel-server/daniel-pi ARE approved, and every way of
reaching some OTHER host is not.
"""

import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "executable_allow-daniel-server.sh")
if not os.path.exists(HOOK):
    HOOK = os.path.join(
        HERE, "allow-daniel-server.sh"
    )  # deployed tree, prefix stripped


def allowed(command):
    """Invoke the hook; return True if it auto-approved the command."""
    payload = json.dumps({"tool_input": {"command": command}})
    p = subprocess.run(
        ["bash", HOOK],
        input=payload,
        capture_output=True,
        text=True,
        env=dict(os.environ, HOOK_INPUT_LIB=os.path.join(HERE, "hook-input.sh")),
    )
    return '"allow"' in p.stdout


# (command, expected_allowed, why)
CASES = [
    # The point of the hook: writes and restarts no longer prompt on this host.
    ("ssh daniel-server uptime", True, "read-only still fine"),
    ("ssh daniel-server systemctl restart traefik", True, "write verb approved"),
    ("ssh daniel-server touch /tmp/scratchfile", True, "file write approved"),
    ("ssh daniel-server docker restart kopia", True, "docker write approved"),
    (
        "ssh daniel-server rm -rf /tmp/scratch",
        True,
        "destructive is approved HERE; block-dangerous-bash.sh denies it on PreToolUse",
    ),
    ("ssh ubuntu@daniel-server whoami", True, "user@ prefix stripped"),
    ("/usr/bin/ssh daniel-server uptime", True, "absolute path to ssh"),
    # Host matching must be exact — substring matches would widen to other machines.
    ("ssh daniel-server-backup uptime", False, "suffix is a different host"),
    ("ssh notdaniel-server uptime", False, "prefix is a different host"),
    ("ssh daniel-pi uptime", True, "second homelab host, read-only"),
    ("ssh daniel-pi docker restart zigbee2mqtt", True, "second homelab host, write"),
    ("ssh ubuntu@daniel-pi whoami", True, "user@ prefix stripped on the Pi too"),
    ("ssh daniel-pi-backup uptime", False, "suffix is a different host"),
    ("ssh notdaniel-pi uptime", False, "prefix is a different host"),
    # Shapes that could reach somewhere other than the two homelab hosts.
    ("ssh daniel-server", False, "interactive shell, no remote command"),
    ("ssh daniel-server ssh daniel-pi uptime", False, "second hop"),
    (
        "ssh daniel-server rsync -a /etc other-host:/backup",
        False,
        "second hop via rsync",
    ),
    ("ssh -L 8182:localhost:8182 daniel-server uptime", False, "options bail out"),
    ("ssh daniel-server uptime; touch /tmp/local", False, "local chaining"),
    ("ssh daniel-server uptime | tee /tmp/out", False, "local pipe"),
    ("ssh daniel-server uptime > /tmp/out", False, "local redirect"),
    ("ssh daniel-server $(cat /tmp/cmd)", False, "command substitution"),
    ("scp /etc/passwd daniel-server:/tmp/", False, "not ssh"),
    # A metacharacter INSIDE the quoted payload is a byte for sshd, not a local
    # split. These are the shapes that used to prompt; the `cd`-prefix idiom is
    # the one `ssh-lands-in-home-not-repo` tells us to write.
    (
        "ssh daniel-server 'cd /home/ubuntu/server; git status --short'",
        True,
        "semicolon in single quotes is payload",
    ),
    (
        'ssh daniel-server "cd /home/ubuntu/server; uv run python scripts/probe.py"',
        True,
        "cd-prefix idiom in double quotes",
    ),
    ("ssh daniel-server 'docker ps | head -20'", True, "pipe in quotes is remote"),
    ("ssh daniel-server 'cat a > /tmp/b'", True, "redirect in quotes is remote"),
    (
        "ssh daniel-pi 'docker logs wg-easy --since 24h 2>&1 | tail -20'",
        True,
        "the documented Pi log idiom",
    ),
    # ...but a double-quoted payload still expands LOCALLY, so $ and ` stay refused.
    ('ssh daniel-server "echo $(whoami)"', False, "double quotes expand locally"),
    ('ssh daniel-server "echo `whoami`"', False, "backtick expands locally"),
    (
        "ssh daniel-server 'echo $(whoami)'",
        True,
        "single quotes reach the remote shell unexpanded; remote is unrestricted",
    ),
    # The second hop must be refused wherever it sits in the payload, now that a
    # `;` can put it past the first token.
    (
        'ssh daniel-server "cd /tmp; ssh other-host uptime"',
        False,
        "second hop behind a cd",
    ),
    (
        'ssh daniel-server "cd /tmp; rsync -a /etc other-host:/backup"',
        False,
        "second hop via rsync behind a cd",
    ),
    # A parse we cannot trust must not produce an approval.
    ("ssh daniel-server 'echo unterminated", False, "unterminated quote"),
    ('ssh daniel-server "uptime" > /tmp/out', False, "redirect outside the quotes"),
    (
        'ssh daniel-server "uptime"; touch /tmp/local',
        False,
        "chaining after a quoted payload",
    ),
]


def main():
    failures = 0
    for command, expected, why in CASES:
        actual = allowed(command)
        if actual != expected:
            failures += 1
            print(
                f"FAIL  expected={'allow' if expected else 'prompt'} "
                f"actual={'allow' if actual else 'prompt'}  {command!r}  ({why})"
            )
    print(f"{len(CASES) - failures}/{len(CASES)} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
