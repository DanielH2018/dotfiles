"""tests/hooks/allow-safe-rm.test.js, case for case. HOME is /home/testuser as there."""

import os
from pathlib import Path

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


def test_a_tmpdir_is_a_root_when_it_resolves_under_tmp():
    # macOS hands TMPDIR over as /private/tmp/..., the real path behind /tmp. Linux has no
    # such link, so there the same spelling resolves outside /tmp and stays refused.
    on_macos = os.path.realpath("/tmp") == "/private/tmp"
    roots = scratch_roots("/home/testuser", "/private/tmp/claude-501/s/")
    assert ("/private/tmp/claude-501/s" in roots) is on_macos


def test_a_tmpdir_that_only_spells_tmp_does_not_move_the_boundary(scratch_dir):
    assert "/tmp/../home/testuser" not in scratch_roots("/home/testuser", "/tmp/../home/testuser")
    link = f"{scratch_dir}/home"
    os.symlink("/etc", link)
    assert link not in scratch_roots("/home/testuser", link)


def test_a_write_into_a_scratch_root_is_confined(scratch_dir):
    assert scratch.write_confined(f"{scratch_dir}/new.txt", ROOTS) is True
    Path(scratch_dir, "old.txt").write_text("x")
    assert scratch.write_confined(f"{scratch_dir}/old.txt", ROOTS) is True


def test_a_write_that_a_link_would_carry_elsewhere_is_not_confined(scratch_dir):
    # A hard link's other name may be anywhere; a second name beside it is enough to show
    # the link count is what refuses.
    victim = Path(scratch_dir, "victim")
    victim.write_text("x")
    os.symlink("/etc/hosts", f"{scratch_dir}/sym")
    os.link(victim, f"{scratch_dir}/hard")
    os.symlink("/etc", f"{scratch_dir}/dir")
    assert scratch.write_confined(f"{scratch_dir}/sym", ROOTS) is False
    assert scratch.write_confined(f"{scratch_dir}/hard", ROOTS) is False
    assert scratch.write_confined(f"{scratch_dir}/dir/new.txt", ROOTS) is False


@pytest.mark.parametrize(
    "target", ["/etc/x", "rel/x.txt", "/tmp/$X/x", "/tmp/a b", "/tmp/nonexistent-dir-9f3/x"]
)
def test_a_write_outside_or_unreadable_is_not_confined(target):
    assert scratch.write_confined(target, ROOTS) is False


# The structure block of the node suite, as assertions on the tables rather than on source.
def test_the_option_tables_stay_closed_allowlists():
    assert frozenset("rRfdvIi") == scratch.BOOL_SHORT
    assert "--no-preserve-root" not in scratch.LONG_OK
    assert (
        frozenset(
            {
                "--recursive",
                "--force",
                "--dir",
                "--verbose",
                "--interactive",
                "--one-file-system",
                "--preserve-root",
            }
        )
        == scratch.LONG_OK
    )


def test_allow_needs_a_confined_operand_not_just_clean_options():
    # The single allow site sits behind "we saw a confined operand" (allow-safe-rm.sh:174).
    assert rm_confined("rm -rf", ROOTS) is False
    assert rm_confined("rm -rf --", ROOTS) is False


# --- #956: a last-component glob and $CLAUDE_JOB_DIR -----------------------------------------

JOB_DIR = "/home/testuser/.claude/jobs/abc123"


def test_a_glob_in_the_last_component_below_a_scratch_dir_is_confined(scratch_dir):
    command = f"rm -f {scratch_dir}/fail*.txt {scratch_dir}/x?.log {scratch_dir}/[ab]"
    assert rm_confined(command, ROOTS, globs=True) is True
    # The caller withholds globs when the chain could plant a link at the parent first.
    assert rm_confined(command, ROOTS, globs=False) is False


@pytest.mark.parametrize(
    "operand",
    [
        "/tmp/*",  # expands to every entry of the root itself
        "{d}/*/x",  # a glob above the last component
        "{d}/.*",  # can match `..`
        "{d}/link/*",  # a parent that resolves outside the roots
        "{d}/absent/*",  # a parent that does not exist
        "{d}/../*",
        "/etc/*",
    ],
)
def test_a_glob_that_could_reach_outside_a_scratch_root_is_refused(scratch_dir, operand):
    os.symlink("/etc", f"{scratch_dir}/link")
    assert rm_confined(f"rm -rf {operand.format(d=scratch_dir)}", ROOTS, globs=True) is False


@pytest.mark.parametrize(
    "command",
    [
        'rm -rf "$CLAUDE_JOB_DIR/tmp"',
        "rm -rf $CLAUDE_JOB_DIR/tmp/x",
        "rm -f ${CLAUDE_JOB_DIR}/tmp/pr.md",
        'rm -rf "$CLAUDE_JOB_DIR"',
    ],
)
def test_a_job_dir_reference_is_expanded_from_the_value_given(command):
    assert rm_confined(command, ROOTS, job_dir=JOB_DIR) is True
    assert rm_confined(command, ROOTS) is False


@pytest.mark.parametrize(
    ("command", "job_dir"),
    [
        # Single quotes keep the reference literal, a relative path the shell resolves.
        ("rm -rf '$CLAUDE_JOB_DIR/tmp'", JOB_DIR),
        ("rm -rf $CLAUDE_JOB_DIRX/tmp", JOB_DIR),
        ("rm -rf $HOME/x", JOB_DIR),
        ("rm -rf ${CLAUDE_JOB_DIR:-/}/tmp", JOB_DIR),
        # The value must itself be confined and a plain word.
        ("rm -rf $CLAUDE_JOB_DIR/x", "/home/testuser"),
        ("rm -rf $CLAUDE_JOB_DIR/x", "/tmp/a b"),
        ("rm -rf $CLAUDE_JOB_DIR/x", "/tmp/*"),
    ],
)
def test_a_job_dir_reference_that_could_name_something_else_is_refused(command, job_dir):
    assert rm_confined(command, ROOTS, job_dir=job_dir) is False
