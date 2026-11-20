"""Tests for the holds that keep a tree: the root helper, the /proc scan, unit locks.

`privileged_holders` takes the helper's answer through `ask`, so most cases pass a
stand-in for the socket. One case binds a real socket, to see the permission gate
through a connect.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import errno
import functools
import json
import os
import pwd
import re
import shutil
import socket
import tempfile
from contextlib import contextmanager
from pathlib import Path

import claude_worktree
import pytest
from _repo import unreadable_proc
from claude_worktree import (
    UNIT_LOCK_GRACE_S,
    Worktree,
    classify,
    holder_root,
    lock_is_live,
    privileged_holders,
    processes_using,
    unit_lock_is_live,
)

SOCK = "/run/worktree-holders.sock"
NOW = 1_800_000_000.0
OLD = NOW - 2 * UNIT_LOCK_GRACE_S
FANOUT_LOCKS = re.compile(r"fanout-\d+(-\d+)*")


@pytest.fixture(autouse=True)
def _warn_afresh():
    """Clear the once-per-process unreachable-socket warning, so each test sees it."""
    claude_worktree._warn_scan_unreachable.cache_clear()


# --- the root helper ------------------------------------------------------------------


def _answering(raw: bytes):
    """A stand-in for `ask_holders` returning `raw` for the socket the caller names."""

    def ask(sock):
        assert sock == SOCK
        return raw

    return ask


def _failing(err: int):
    def ask(sock):
        raise OSError(err, os.strerror(err), sock)

    return ask


def _ask(tmp_path: Path, ask):
    root = tmp_path / "worktrees"
    return privileged_holders(root / "a", sock=SOCK, root=root, ask=ask)


@contextmanager
def _short_socket_path():
    """A socket path under `/tmp` itself.

    `sun_path` holds 107 bytes, which a long temp root exceeds.
    """
    directory = Path(tempfile.mkdtemp(prefix="hs", dir="/tmp"))
    try:
        yield directory / "worktree-holders.sock"
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _listening(path: Path) -> socket.socket:
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(path))
        listener.listen(1)
    except BaseException:
        listener.close()
        raise
    return listener


def test_the_helper_sees_another_uid_outside_this_slice_is_flagged(tmp_path):
    # `systemd-run --uid=claude --working-directory=<tree>` lands in claude's slice,
    # where the unprivileged scan cannot look. The helper reads it as root.
    root = tmp_path / "worktrees"
    tree, sibling = root / "a", root / "b"
    raw = f"ok\n4242\tcwd\t{tree}/sub\n4243\tcwd\t{sibling}\nend\n".encode()

    found = privileged_holders(tree, sock=SOCK, root=root, ask=_answering(raw))

    assert found == [(4242, f"cwd {tree}/sub")]


def test_an_answer_with_its_framing_and_no_holder_leaves_the_tree_free_is_clean(
    tmp_path,
):
    assert _ask(tmp_path, _answering(b"ok\nend\n")) == []


def test_a_refused_garbled_or_truncated_answer_refuses_removal_is_flagged(tmp_path):
    # A socket carries no exit status. An instance that died mid-scan sends a prefix
    # of a good answer, or nothing, and neither may read as "no holder".
    for raw in (
        b"refused\t/etc/worktree-holders.json maps no worktree root for uid 1001\n",
        b"",
        b"ok\n",
        b"ok\n4242\tcwd\t/x\n",
        b"4242\tcwd\t/x\nend\n",
        b"ok\n4242 cwd /x\nend\n",
        b"ok\nend\nok\n",
        b"ok\n4242\tunreadable\tcwd: EPERM\nend\n",
        "ok\n4242\tcwd\t/café\nend\n".encode(),
        b"ok\n4242\tcwd\t/x\\x00y\nend\n",
    ):
        found = _ask(tmp_path, _answering(raw))
        assert found and found[0][0] in (0, 4242), raw


def test_a_refused_connection_or_timeout_refuses_removal_is_flagged(tmp_path):
    # The socket is there, so the scan applies: a refused connection is a stopped
    # service whose file stayed behind, and a timeout is a hung instance.
    for err in (errno.ECONNREFUSED, errno.ETIMEDOUT):
        found = _ask(tmp_path, _failing(err))
        assert found and found[0][0] == 0, err


def test_no_socket_a_group_gate_or_a_tree_outside_its_root_falls_back_is_clean(
    tmp_path, capsys
):
    # A host without the apply, a session older than its user's group grant, and a
    # tree the helper never reports on: each must scan /proc itself rather than read
    # "no holder", and the first two say so on stderr.
    root = tmp_path / "worktrees"

    assert _ask(tmp_path, _failing(errno.ENOENT)) is None
    assert _ask(tmp_path, _failing(errno.EACCES)) is None
    assert "cannot connect to" in capsys.readouterr().err
    assert (
        privileged_holders(
            tmp_path / "elsewhere", sock=SOCK, root=root, ask=_answering(b"")
        )
        is None
    )

    me = os.getuid()
    proc = unreadable_proc(
        tmp_path / "proc", 4242, me + 1, f"/user.slice/user-{me}.slice/session-7.scope"
    )
    found = processes_using(str(tmp_path), proc=proc, privileged=lambda _: None)
    assert [pid for pid, _ in found] == [4242]


def test_a_user_the_map_does_not_name_still_asks_the_socket_and_warns_nothing(
    tmp_path, capsys
):
    # `root=None` is a host with no entry for this user. The socket is asked wherever it
    # exists; where it does not, the slice rule runs and stderr stays quiet.
    tree = tmp_path / "worktrees" / "a"

    assert privileged_holders(tree, SOCK, None, _failing(errno.ENOENT)) is None
    assert capsys.readouterr().err == ""
    assert privileged_holders(tree, SOCK, None, _answering(b"ok\nend\n")) == []


def test_the_caller_asks_about_the_root_the_helper_maps_it_to_is_flagged(tmp_path):
    # The agent user's root is its own clone, which the root map names. Asking anywhere
    # else could disagree with the root the helper scans, and an empty answer would then
    # read as "no holder".
    clone = tmp_path / "clone" / ".claude" / "worktrees"
    roots = tmp_path / "worktree-holders.json"
    roots.write_text(json.dumps({pwd.getpwuid(os.getuid()).pw_name: str(clone)}))

    assert holder_root(str(roots)) == clone


def test_with_no_map_entry_there_is_no_root_is_clean(tmp_path):
    # No map, no entry for this user, or a relative path: the helper is not
    # installed for this user, so the caller has no root to ask under.
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"someone-else": "/elsewhere"}))
    relative = tmp_path / "relative.json"
    relative.write_text(json.dumps({pwd.getpwuid(os.getuid()).pw_name: "rel/wt"}))

    for roots in (tmp_path / "absent.json", other, relative):
        assert holder_root(str(roots)) is None, roots


def test_processes_using_takes_the_helpers_answer_over_the_proc_scan_is_flagged(
    tmp_path,
):
    answer = [(4242, "cwd /w/a")]

    assert (
        processes_using(
            str(tmp_path), proc=tmp_path / "no-proc", privileged=lambda _: answer
        )
        == answer
    )


@pytest.mark.skipif(os.getuid() == 0, reason="root connects to a mode 000 socket")
def test_a_real_socket_this_uid_may_not_write_falls_back_is_clean(tmp_path, capsys):
    # The group gate through a real connect: a socket whose mode shuts this uid out
    # raises EACCES, which reads as "not granted yet", not as a failed scan.
    root = tmp_path / "worktrees"
    with _short_socket_path() as sock, _listening(sock):
        sock.chmod(0o000)
        found = privileged_holders(root / "a", sock=str(sock), root=root)

    assert found is None
    assert "Permission denied" in capsys.readouterr().err


# --- the /proc scan -------------------------------------------------------------------


def test_another_uids_process_in_my_login_slice_holds_every_tree_is_flagged(tmp_path):
    # `sudo -u claude sleep` run from inside a worktree keeps its inherited cwd and
    # stays in the caller's slice, and the caller cannot read that cwd.
    me = os.getuid()
    proc = unreadable_proc(
        tmp_path / "proc", 4242, me + 1, f"/user.slice/user-{me}.slice/session-7.scope"
    )

    found = processes_using(str(tmp_path), proc=proc, privileged=lambda _: None)

    assert [pid for pid, _ in found] == [4242]


def test_a_test_that_ignores_foreign_slice_holds_sees_no_holder_is_clean(
    tmp_path, own_processes_only
):
    # The flagged half is the test above: the same process, with the rule left on.
    me = os.getuid()
    proc = unreadable_proc(
        tmp_path / "proc", 4242, me + 1, f"/user.slice/user-{me}.slice/session-7.scope"
    )

    assert processes_using(str(tmp_path), proc=proc, privileged=lambda _: None) == []


def test_unreadable_processes_outside_that_rule_do_not_block_removal_is_clean(tmp_path):
    # Each of these is always alive on a host with a second user, so counting any would
    # refuse every removal: the agent's resident service, another user's own session,
    # root's daemons and `sshd [priv]` inside this very slice.
    me = os.getuid()
    proc = tmp_path / "proc"
    unreadable_proc(proc, 1, me + 1, "/user.slice/claude-rc.service")
    unreadable_proc(proc, 2, me + 1, f"/user.slice/user-{me + 1}.slice/session-9.scope")
    unreadable_proc(proc, 3, 0, "/system.slice/cron.service")
    unreadable_proc(proc, 4, 0, f"/user.slice/user-{me}.slice/session-7.scope")

    assert processes_using(str(tmp_path), proc=proc, privileged=lambda _: None) == []


# --- unit locks -----------------------------------------------------------------------


def _batch_tree(tmp_path, locked_at: float = OLD) -> str:
    """A worktree whose `.git` file points at an admin dir holding a lock file."""
    tree, admin = tmp_path / "fanout-8529", tmp_path / "admin"
    tree.mkdir()
    admin.mkdir()
    (tree / ".git").write_text(f"gitdir: {admin}\n")
    (admin / "locked").write_text("fanout-8529")
    os.utime(admin / "locked", (locked_at, locked_at))
    return str(tree)


def _batch_worktree(tmp_path) -> Worktree:
    return Worktree(
        _batch_tree(tmp_path), "abc", "worktree-fanout-8529", True, "fanout-8529"
    )


def _is_live(tree: str, state: "str | None") -> bool:
    return unit_lock_is_live(tree, "fanout-8529", lambda unit: state, NOW)


def _foreign_is_live(tree: str, foreign) -> bool:
    return unit_lock_is_live(
        tree, "fanout-8529", lambda unit: "active", NOW, foreign, os.getuid() + 1
    )


def test_a_merged_tree_whose_batch_unit_is_gone_is_removable(tmp_path):
    live = functools.partial(
        lock_is_live, unit_locks=FANOUT_LOCKS, state=lambda unit: "inactive", now=NOW
    )

    verdict, _ = classify(_batch_worktree(tmp_path), "ancestry", False, lock_live=live)

    assert verdict == "removable"


def test_a_merged_tree_whose_batch_unit_runs_is_kept(tmp_path):
    live = functools.partial(
        lock_is_live, unit_locks=FANOUT_LOCKS, state=lambda unit: "active", now=NOW
    )

    verdict, why = classify(
        _batch_worktree(tmp_path), "ancestry", False, lock_live=live
    )

    assert (verdict, why) == ("keep", "in use — fanout-8529")


def test_a_lock_reason_the_pattern_does_not_name_is_judged_as_a_session(tmp_path):
    # An unrecognised reason is someone else's lock, so it reads as live whatever a unit
    # manager would say.
    tree = Worktree(_batch_tree(tmp_path), "abc", "worktree-x", True, "something-else")

    assert lock_is_live(tree, FANOUT_LOCKS, state=lambda unit: "inactive", now=NOW)
    assert lock_is_live(tree, None, state=lambda unit: "inactive", now=NOW)


@pytest.mark.parametrize("state", ["inactive", "failed"])
def test_a_finished_unit_releases_an_old_lock(tmp_path, state):
    assert not _is_live(_batch_tree(tmp_path), state)


def test_a_manager_that_cannot_be_asked_keeps_the_tree(tmp_path):
    assert _is_live(_batch_tree(tmp_path), None)


def test_a_lock_inside_the_grace_keeps_the_tree_before_its_unit_starts(tmp_path):
    assert _is_live(_batch_tree(tmp_path, locked_at=NOW - 60), "inactive")


def test_an_unreadable_lock_file_keeps_the_tree(tmp_path):
    tree = _batch_tree(tmp_path)
    (tmp_path / "admin" / "locked").unlink()
    assert _is_live(tree, "inactive")


def test_another_users_tree_reads_live_to_a_caller_that_removes_trees(tmp_path):
    assert _foreign_is_live(_batch_tree(tmp_path), None)


def test_another_users_tree_whose_unit_is_active_is_live(tmp_path):
    assert _foreign_is_live(_batch_tree(tmp_path), lambda unit: "active")


def test_another_users_tree_whose_unit_is_gone_is_released(tmp_path):
    assert not _foreign_is_live(_batch_tree(tmp_path), lambda unit: "inactive")


def test_another_users_tree_whose_unit_cannot_be_read_stays_live(tmp_path):
    assert _foreign_is_live(_batch_tree(tmp_path), lambda unit: None)
