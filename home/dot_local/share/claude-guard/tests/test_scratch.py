"""tests/hooks/allow-safe-rm.test.js, case for case. HOME is /home/testuser as there."""

import pytest

from claude_guard.checks import scratch
from claude_guard.checks.scratch import rm_confined
from claude_guard.tables import scratch_roots

ROOTS = scratch_roots("/home/testuser")

ALLOW = [
    "rm -rf /tmp/scratch",
    "rm -f /tmp/claude-1000/session/x.json",
    "rm /tmp/a/b/c.txt",
    "rm -rf /var/tmp/build",
    "rm -rf /home/testuser/.claude/jobs/abc123/tmp",
    "rm -rf /home/testuser/.cache/claude/x",
    "rm -rfv /tmp/a /tmp/b",
    "rm --recursive --force /tmp/a",
    "rm -rf -- /tmp/a",
    'rm -rf "/tmp/a b"',
    "rm -rf '/tmp/a b'",
    "/usr/bin/rm -rf /tmp/a",
]

DEFER = [
    # The scratch roots themselves are not scratch.
    "rm -rf /tmp",
    "rm -rf /tmp/",
    "rm -rf /var/tmp",
    "rm -rf /home/testuser/.claude/jobs",
    "rm -rf /",
    # Traversal out of a root, lexically or quoted.
    "rm -rf /tmp/../etc",
    'rm -rf "/tmp/../etc"',
    "rm -rf /tmp/a/../../etc",
    # One bad operand condemns the whole command.
    "rm -rf /tmp/a /etc/passwd",
    "rm -rf /tmp/a /home/testuser/.ssh",
    # Outside any root.
    "rm -rf /home/testuser/.ssh",
    "rm -rf /etc/passwd",
    "rm -rf /home/testuser/src/project",
    # Shell expansion happens after the decision, so none of it is readable here.
    "rm -rf /tmp/*",
    "rm -rf /tmp/?",
    "rm -rf /tmp/[ab]",
    "rm -rf $HOME/x",
    'rm -rf "$HOME/x"',
    "rm -rf ~/scratch",
    "rm -rf `echo /tmp/a`",
    "rm -rf $(echo /tmp/a)",
    "rm -rf /tmp/a\\ b",
    # Relative paths: the cwd is unknown to a PermissionRequest hook.
    "rm -rf scratch",
    "rm -rf ./scratch",
    "rm -rf ../scratch",
    # Chaining, piping and redirection belong to the judge, not here.
    "rm -rf /tmp/a && rm -rf /etc",
    "rm -rf /tmp/a; rm -rf /etc",
    "rm -rf /tmp/a | tee /etc/x",
    "rm -rf /tmp/a > /etc/x",
    # The one option that would make every path check above a lie.
    "rm --no-preserve-root -rf /tmp/a",
    # Unnamed options are not decisions.
    "rm --unknown-flag /tmp/a",
    "rm -z /tmp/a",
    "rm -rz /tmp/a",
    # Not this hook's command, or no operand at all.
    "rm",
    "rm -rf",
    "rmdir /tmp/a",
    "srm -rf /tmp/a",
    "sudo rm -rf /tmp/a",
    "TMPDIR=/ rm -rf /tmp/a",
    # Collapsed separators: refuse rather than guess.
    "rm -rf /tmp//a",
    # Unterminated quote.
    'rm -rf "/tmp/a',
    # Empty command.
    "",
]


@pytest.mark.parametrize("command", ALLOW)
def test_a_delete_confined_to_a_scratch_root_is_allowed(command):
    assert rm_confined(command, ROOTS) is True


@pytest.mark.parametrize("command", DEFER)
def test_anything_not_provably_confined_is_refused(command):
    assert rm_confined(command, ROOTS) is False


def test_tmpdir_can_only_ever_narrow_never_widen():
    assert (
        rm_confined(
            "rm -rf /home/testuser/secrets", scratch_roots("/home/testuser", "/home/testuser")
        )
        is False
    )
    assert (
        rm_confined("rm -rf /home/testuser/secrets", scratch_roots("/home/testuser", "/tmp/x"))
        is False
    )
    # A TMPDIR under /tmp is already covered by the /tmp root itself.
    assert rm_confined("rm -rf /tmp/x/a", scratch_roots("/home/testuser", "/tmp/x")) is True


# The structure block of the node suite, as assertions on the tables rather than on source.
def test_the_option_tables_stay_closed_allowlists():
    assert frozenset("rRfdvIi") == scratch.BOOL_SHORT
    assert "--no-preserve-root" not in scratch.LONG_OK
    assert frozenset(
        {
            "--recursive",
            "--force",
            "--dir",
            "--verbose",
            "--interactive",
            "--one-file-system",
            "--preserve-root",
        }
    ) == scratch.LONG_OK


def test_allow_needs_a_confined_operand_not_just_clean_options():
    # The single allow site sits behind "we saw a confined operand" (allow-safe-rm.sh:174).
    assert rm_confined("rm -rf", ROOTS) is False
    assert rm_confined("rm -rf --", ROOTS) is False
