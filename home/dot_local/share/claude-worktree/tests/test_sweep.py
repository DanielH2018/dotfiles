"""Tests for the sweep's CLI: dispatch, exit codes, reports, policy and the launcher.

Each test runs `main` in-process from a scratch repository, with the real git the sweep
reads. A test that removes a tree asks for `own_processes_only`, because an unreadable
process elsewhere on the host would otherwise hold every tree.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import claude_worktree
import claude_worktree_sweep
import pytest
from _repo import commit, git, git_out, init_repo, land, scrubbed_env, session_tree
from claude_worktree import KEEP, REMOVABLE, REVIEW, Worktree
from claude_worktree_sweep import (
    VANISHED,
    Policy,
    PolicyError,
    Sweep,
    read_policy,
    survey_report,
)

PACKAGE = Path(__file__).resolve().parents[1]
LAUNCHER = (
    Path(__file__).resolve().parents[4]
    / "private_dot_claude"
    / "hooks"
    / "executable_prune-worktrees.py"
)


def _repo(tmp_path: Path) -> Path:
    """A repository with one commit, `origin/master` on it, and `.claude/` ignored."""
    repo = init_repo(tmp_path / "repo")
    commit(repo, "init", **{"a.txt": "one\n"})
    (repo / ".git" / "info" / "exclude").write_text(".claude/\n")
    land(repo, "master")
    return repo


def _main(repo: Path, monkeypatch, capsys, *argv: str) -> subprocess.CompletedProcess:
    """`main(argv)` run from `repo`; the result holds the exit code and both streams."""
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.chdir(repo)
    capsys.readouterr()
    code = claude_worktree_sweep.main(list(argv))
    out, err = capsys.readouterr()
    return subprocess.CompletedProcess(argv, code, out, err)


def _work_tree(repo: Path, name: str, **files: str) -> Path:
    """A session tree `<name>` on `worktree-<name>`, holding one commit of its own."""
    tree = session_tree(repo, name, f"worktree-{name}")
    commit(tree, f"work on {name}", **(files or {f"{name}.txt": "x\n"}))
    return tree


def _land_branches(repo: Path, *branches: str) -> None:
    """Merge each branch into master and point `origin/master` at the result."""
    git(repo, "merge", "-q", "--no-edit", *branches)
    land(repo, "master")


def _write_policy(repo: Path, policy: object) -> None:
    path = repo / ".claude" / "prune-worktrees.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(policy))


def _two_landed_trees(repo: Path) -> list[Path]:
    trees = [_work_tree(repo, "w0"), _work_tree(repo, "w1")]
    _land_branches(repo, "worktree-w0", "worktree-w1")
    return trees


def _patch_id_landed(repo: Path, name: str) -> Path:
    """A tree whose commit reached master as a cherry-pick: new SHA, same patch."""
    tree = _work_tree(repo, name)
    git(repo, "cherry-pick", "-x", f"worktree-{name}")
    land(repo, "master")
    return tree


def _content_landed(repo: Path, name: str) -> Path:
    """A tree whose branch master absorbed as one squash commit: no patch-id matches."""
    tree = session_tree(repo, name, f"worktree-{name}")
    commit(tree, "first", **{f"{name}.txt": "draft\n"})
    commit(tree, "second", **{f"{name}.txt": "final\n"})
    commit(repo, "squash", **{f"{name}.txt": "final\n"})
    land(repo, "master")
    return tree


def _sweep(repo: Path, **fields) -> Sweep:
    return Sweep(
        repo=str(repo),
        base=claude_worktree.default_ref(str(repo)) or "",
        policy=read_policy(str(repo)),
        **fields,
    )


# --- the --brief / --prune dispatch ---------------------------------------------------
#
# These drive `main`, because a dispatch that returned from the `--brief` branch before
# the prune block would leave `brief_report` itself correct.


def test_prune_with_brief_removes_every_removable_worktree(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # --brief shortens the report, it does not cancel --prune
    repo = _repo(tmp_path)
    trees = _two_landed_trees(repo)

    done = _main(repo, monkeypatch, capsys, "--prune", "--brief")

    assert done.returncode == 0, done.stderr
    assert not any(tree.exists() for tree in trees)


def test_brief_without_prune_removes_nothing(tmp_path, monkeypatch, capsys):
    # --brief alone is the SessionStart banner and must stay read-only
    repo = _repo(tmp_path)
    trees = _two_landed_trees(repo)

    done = _main(repo, monkeypatch, capsys, "--brief")

    assert done.returncode == 0, done.stderr
    assert all(tree.is_dir() for tree in trees)
    assert "WARN: 2 merged worktree(s) can be removed:" in done.stdout
    assert f"→ {claude_worktree_sweep.COMMAND} --prune" in done.stdout


def test_brief_shows_a_removable_trees_label_beside_its_name(
    tmp_path, monkeypatch, capsys
):
    repo = _repo(tmp_path)
    _write_policy(repo, {"label_file": ".claim"})
    _work_tree(repo, "w0", **{".claim": "#1345 Fix the cert watcher\n"})
    _work_tree(repo, "w1")
    _land_branches(repo, "worktree-w0", "worktree-w1")

    done = _main(repo, monkeypatch, capsys, "--brief")

    assert "  w0 [#1345 Fix the cert watcher] — worktree-w0 merged" in done.stdout
    assert "  w1 — worktree-w1 merged" in done.stdout


def test_the_long_report_shows_a_trees_label_after_its_path(
    tmp_path, monkeypatch, capsys
):
    repo = _repo(tmp_path)
    _write_policy(repo, {"label_file": ".claim"})
    tree = _work_tree(repo, "w0", **{".claim": "#1345 Fix the cert watcher\n"})
    _land_branches(repo, "worktree-w0")

    done = _main(repo, monkeypatch, capsys)

    assert f"[{REMOVABLE:9}] {tree} [#1345 Fix the cert watcher]" in done.stdout


def test_a_label_is_cut_to_its_first_line_and_80_characters(tmp_path):
    repo = _repo(tmp_path)
    _write_policy(repo, {"label_file": ".claim"})
    tree = tmp_path / "t"
    tree.mkdir()
    (tree / ".claim").write_text("x" * 100 + "\nsecond line\n")

    assert _sweep(repo).label("name", str(tree)) == f"name [{'x' * 80}]"


def test_prune_with_brief_does_not_tell_the_caller_to_re_run_prune(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # the hint that made a no-op read as a report must not survive an actual prune
    repo = _repo(tmp_path)
    _two_landed_trees(repo)

    done = _main(repo, monkeypatch, capsys, "--prune", "--brief")

    assert "--prune" not in done.stdout
    assert done.stdout.count(f"removed {repo}/.claude/worktrees/") == 2


def test_prune_without_brief_still_removes_every_removable_worktree(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path)
    trees = _two_landed_trees(repo)

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not any(tree.exists() for tree in trees)


def test_prune_ends_with_a_result_line_a_caller_reads_by_field(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo = _repo(tmp_path)
    tree = _two_landed_trees(repo)[0]

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.stdout.splitlines()[-1] == (
        "PRUNE-RESULT: removed=2 failed=0 in_use=0 branches=2"
    )
    assert f"removed {tree} (worktree-w0)" in done.stdout
    assert "deleted worktree-w0" in done.stdout


def test_one_prune_removes_a_worktree_and_deletes_the_branch_it_freed(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # A branch is only an orphan once its worktree is gone, so a list read before the
    # removals names none of the branches those removals free.
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "done")
    _land_branches(repo, "worktree-done")

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not tree.exists(), done.stderr
    assert "worktree-done" not in git_out(repo, "branch", "--format=%(refname:short)")


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores a directory's mode")
@pytest.mark.parametrize("argv", [["--prune", "--brief"], ["--prune"]])
def test_prune_exits_1_when_a_removal_failed(
    tmp_path, monkeypatch, capsys, own_processes_only, argv
):
    # The timer's invocation: a removal git refused must not exit 0.
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "stuck")
    _land_branches(repo, "worktree-stuck")
    sessions = repo / ".claude" / "worktrees"
    sessions.chmod(0o555)
    try:
        done = _main(repo, monkeypatch, capsys, *argv)
    finally:
        sessions.chmod(0o755)

    assert done.returncode == 1, done.stderr
    assert tree.is_dir()
    assert f"could not remove {tree}:" in done.stderr
    assert "failed=1" in done.stdout.splitlines()[-1]


def test_a_removal_git_refused_is_reported_with_the_advice_for_its_path(
    tmp_path, monkeypatch, capsys
):
    # `survey` saw a clean tree; a file written after that makes git refuse the removal.
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "late")
    _land_branches(repo, "worktree-late")
    monkeypatch.setattr(
        claude_worktree,
        "foreign_owned_advice",
        lambda path: [f"  blocked under {path}"],
    )
    (tree / "written-after-the-survey.txt").write_text("work\n")
    tally = claude_worktree_sweep.Tally()

    claude_worktree_sweep.prune_trees(
        str(repo), [Worktree(str(tree), "", "worktree-late", False)], tally, sys.stderr
    )

    err = capsys.readouterr().err
    assert tally.failed == 1 and tally.removed == 0
    assert f"could not remove {tree}:" in err
    assert err.rstrip().endswith(f"  blocked under {tree}")


def test_a_prune_that_skips_a_worktree_a_live_process_holds_exits_0(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # One session running at the sweep's hour must not fail a timer's check for a week.
    # The skip is still named on stderr, and a later run removes the tree once the
    # holder exits.
    repo = _repo(tmp_path)
    held = _work_tree(repo, "held")
    _land_branches(repo, "worktree-held")
    holder = subprocess.Popen(["sleep", "120"], cwd=held)
    try:
        done = _main(repo, monkeypatch, capsys, "--prune", "--brief")
    finally:
        holder.kill()
        holder.wait()

    assert held.is_dir()
    assert f"kept {held}: in use by a live process: pid {holder.pid} (" in done.stderr
    assert "; removed once it exits" in done.stderr
    assert done.returncode == 0, done.stderr
    assert done.stdout.splitlines()[-1] == (
        "PRUNE-RESULT: removed=0 failed=0 in_use=1 branches=0"
    )


# --- a registered worktree whose directory is gone -----------------------------------
#
# `git worktree list` keeps the registration, marked prunable, until `git worktree
# prune` runs. Asking git about the dead path must not take down the report or a prune.


def _repo_with_a_vanished_worktree(tmp_path: Path) -> tuple[Path, Path, Path]:
    """A repo holding one merged live tree and one registered at a deleted path."""
    repo = _repo(tmp_path)
    done = _work_tree(repo, "done")
    gone = repo / ".claude" / "worktrees" / "gone"
    git(repo, "worktree", "add", "-q", "--detach", str(gone))
    shutil.rmtree(gone)
    _land_branches(repo, "worktree-done")
    return repo, done, gone


def test_report_survives_a_worktree_registered_at_a_deleted_path(
    tmp_path, monkeypatch, capsys
):
    repo, _, _ = _repo_with_a_vanished_worktree(tmp_path)

    done = _main(repo, monkeypatch, capsys)

    assert "FileNotFoundError" not in done.stderr
    assert done.returncode == 0, done.stderr


def test_report_still_names_the_live_worktrees_beside_a_vanished_one(
    tmp_path, monkeypatch, capsys
):
    # One stale registration must not hide the rest.
    repo, live, _ = _repo_with_a_vanished_worktree(tmp_path)

    done = _main(repo, monkeypatch, capsys)

    assert f"[{REMOVABLE:9}] {live}" in done.stdout, done.stderr


def test_the_weekly_prune_removes_merged_worktrees_beside_a_vanished_one(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    repo, live, _ = _repo_with_a_vanished_worktree(tmp_path)

    done = _main(repo, monkeypatch, capsys, "--prune", "--brief")

    assert done.returncode == 0, done.stderr
    assert not live.exists(), done.stderr


def test_report_names_the_vanished_tree_and_does_not_offer_to_remove_it(
    tmp_path, monkeypatch, capsys
):
    repo, _, gone = _repo_with_a_vanished_worktree(tmp_path)

    done = _main(repo, monkeypatch, capsys)

    assert f"[{VANISHED:9}] {gone}" in done.stdout, done.stderr
    assert f"[{REMOVABLE:9}] {gone}" not in done.stdout


def test_plain_prune_drops_a_vanished_registration_when_nothing_else_is_removable(
    tmp_path, monkeypatch, capsys
):
    repo = _repo(tmp_path)
    gone = repo / ".claude" / "worktrees" / "gone"
    git(repo, "worktree", "add", "-q", "--detach", str(gone))
    shutil.rmtree(gone)

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert str(gone) not in git_out(repo, "worktree", "list")


# --- the long report's counting -------------------------------------------------------


def _surveyed():
    def tree(name: str) -> Worktree:
        return Worktree(f"/repo/.claude/worktrees/{name}", "abc", f"b-{name}", False)

    return [
        (REMOVABLE, tree("merged"), "merged"),
        (VANISHED, tree("gone"), "directory gone"),
        (KEEP, tree("busy"), "has uncommitted work"),
        (KEEP, tree("locked"), "locked by a live session"),
    ]


def test_the_long_report_lists_removable_and_vanished_and_counts_the_kept():
    sweep = Sweep(repo="/repo", base="", policy=Policy())

    lines = survey_report(sweep, _surveyed(), show_all=False)

    out = "\n".join(lines)
    assert "merged" in out and "directory gone" in out
    assert "has uncommitted work" not in out
    assert lines[-1] == "2 worktree(s) kept; --all lists them"


def test_all_lists_the_kept_worktrees_too():
    sweep = Sweep(repo="/repo", base="", policy=Policy())

    out = "\n".join(survey_report(sweep, _surveyed(), show_all=True))

    assert "has uncommitted work" in out and "locked by a live session" in out
    assert "kept; --all lists them" not in out


def test_the_long_report_totals_what_a_prune_would_remove(
    tmp_path, monkeypatch, capsys
):
    repo, _, _ = _repo_with_a_vanished_worktree(tmp_path)
    dirty = _work_tree(repo, "dirty")
    (dirty / "wip.txt").write_text("uncommitted\n")

    done = _main(repo, monkeypatch, capsys)

    assert done.returncode == 0, done.stderr
    assert "1 worktree(s) kept; --all lists them" in done.stdout
    assert "worktree-dirty" not in done.stdout
    assert done.stdout.splitlines()[-1] == (
        "1 worktree(s), 0 orphan dir(s), 0 branch(es) and 1 vanished "
        "registration(s) removable — re-run with --prune to remove"
    )
    listed = _main(repo, monkeypatch, capsys, "--all").stdout
    assert "uncommitted changes" in listed


def test_a_clean_repo_reports_nothing_to_remove(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path)

    done = _main(repo, monkeypatch, capsys)

    assert done.returncode == 0
    assert done.stdout.strip() == "nothing to remove"


# --- --check BRANCH and the exit codes -----------------------------------------------


def test_check_names_the_layer_that_settled_a_rebase_landed_branch(
    tmp_path, monkeypatch, capsys
):
    # Not ancestry: the cherry-pick lands the patch under a new SHA, so only the
    # patch-id layer settles it, and naming it is what --check adds over a yes or no.
    repo = _repo(tmp_path)
    _patch_id_landed(repo, "rebased")

    done = _main(repo, monkeypatch, capsys, "--check", "worktree-rebased")

    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "worktree-rebased: landed (patch-id)"


def test_check_exits_1_for_a_branch_holding_unlanded_work(
    tmp_path, monkeypatch, capsys
):
    # GH_BIN=false keeps the forge layer offline: a failed forge lookup is no verdict,
    # which must read as unlanded.
    monkeypatch.setenv("GH_BIN", "false")
    repo = _repo(tmp_path)
    _work_tree(repo, "open")

    done = _main(repo, monkeypatch, capsys, "--check", "worktree-open")

    assert done.returncode == 1, done.stderr
    assert done.stdout.strip() == "worktree-open: unlanded"


def test_check_exits_64_for_a_branch_that_does_not_exist(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path)

    done = _main(repo, monkeypatch, capsys, "--check", "no-such-branch")

    assert done.returncode == 64
    assert "no such branch or commit: no-such-branch" in done.stderr


def test_outside_a_checkout_a_report_exits_1_and_a_banner_stays_silent(
    tmp_path, monkeypatch, capsys
):
    outside = tmp_path / "outside"
    outside.mkdir()

    report = _main(outside, monkeypatch, capsys)
    banner = _main(outside, monkeypatch, capsys, "--brief")
    check = _main(outside, monkeypatch, capsys, "--check", "x")

    assert report.returncode == 1
    assert "not inside a git checkout" in report.stderr
    assert (banner.returncode, banner.stdout, banner.stderr) == (0, "", "")
    assert check.returncode == 64


# --- --require ------------------------------------------------------------------------


def test_require_above_the_interface_exits_78(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path)

    done = _main(
        repo, monkeypatch, capsys, "--require", str(claude_worktree.INTERFACE + 1)
    )

    assert done.returncode == 78
    assert f"interface {claude_worktree.INTERFACE}" in done.stderr
    assert done.stdout == ""


@pytest.mark.parametrize("offset", [0, -1])
def test_require_at_or_below_the_interface_runs(tmp_path, monkeypatch, capsys, offset):
    repo = _repo(tmp_path)

    done = _main(
        repo,
        monkeypatch,
        capsys,
        "--require",
        str(claude_worktree.INTERFACE + offset),
        "--check",
        "master",
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "master: landed (ancestry)"


# --- the policy -----------------------------------------------------------------------


def test_read_policy_with_no_file_is_the_strictest(tmp_path):
    policy = read_policy(str(tmp_path))

    assert policy == Policy()
    assert policy.session_start is True
    assert policy.acts == frozenset({"ancestry", "forge"})
    assert policy.branch_prefixes == ("worktree-",)
    assert policy.unit_locks is None
    assert policy.branch_holds == ()
    assert policy.label_file == ""


def test_read_policy_parses_every_key(tmp_path):
    _write_policy(
        tmp_path,
        {
            "session_start": "off",
            "landed_by": ["patch-id", "content"],
            "branch_prefixes": ["worktree-", "claude/"],
            "unit_locks": "fanout-.*",
            "branch_holds": ["gh-heads", "--open"],
            "label_file": ".claim",
        },
    )

    policy = read_policy(str(tmp_path))

    assert policy.session_start is False
    assert policy.acts == frozenset({"ancestry", "forge", "patch-id", "content"})
    assert policy.branch_prefixes == ("worktree-", "claude/")
    assert policy.unit_locks is not None and policy.unit_locks.pattern == "fanout-.*"
    assert policy.branch_holds == ("gh-heads", "--open")
    assert policy.label_file == ".claim"


@pytest.mark.parametrize(
    "policy",
    [
        {"session_stat": "off"},
        ["landed_by"],
        {"landed_by": ["ancestry"]},
        {"landed_by": "patch-id"},
        {"session_start": "never"},
    ],
    ids=["unknown-key", "not-an-object", "bad-layer", "not-a-list", "bad-mode"],
)
def test_read_policy_refuses_a_file_it_cannot_use_as_written(tmp_path, policy):
    _write_policy(tmp_path, policy)

    with pytest.raises(PolicyError):
        read_policy(str(tmp_path))


def test_read_policy_refuses_a_file_that_is_not_json(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "prune-worktrees.json").write_text("{nope")

    with pytest.raises(PolicyError, match="not JSON"):
        read_policy(str(tmp_path))


def test_a_bad_policy_exits_78_and_removes_nothing(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # A sweep that guessed at a policy it could not read would be guessing what it may
    # delete.
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "done")
    _land_branches(repo, "worktree-done")
    _write_policy(repo, {"landed_bye": ["content"]})

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 78
    assert "unknown key(s): landed_bye; nothing was pruned" in done.stderr
    assert tree.is_dir()
    assert "worktree-done" in git_out(repo, "branch", "--format=%(refname:short)")


@pytest.mark.parametrize("builder", [_patch_id_landed, _content_landed])
def test_a_tree_landed_by_patch_id_or_content_is_reviewed_not_removed(
    tmp_path, monkeypatch, capsys, own_processes_only, builder
):
    # Both layers also describe a branch that later work superseded, so only ancestry
    # and the forge act unless the repo's policy says otherwise.
    repo = _repo(tmp_path)
    tree = builder(repo, "work")

    report = _main(repo, monkeypatch, capsys)
    done = _main(repo, monkeypatch, capsys, "--prune")

    assert f"[{REVIEW:9}] {tree}" in report.stdout
    assert done.returncode == 0, done.stderr
    assert tree.is_dir()
    assert "worktree-work" in git_out(repo, "branch", "--format=%(refname:short)")
    assert done.stdout.splitlines()[-1] == (
        "PRUNE-RESULT: removed=0 failed=0 in_use=0 branches=0"
    )


@pytest.mark.parametrize("builder", [_patch_id_landed, _content_landed])
def test_landed_by_lets_a_patch_id_or_content_tree_be_removed(
    tmp_path, monkeypatch, capsys, own_processes_only, builder
):
    repo = _repo(tmp_path)
    _write_policy(repo, {"landed_by": ["patch-id", "content"]})
    tree = builder(repo, "work")

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert not tree.exists(), done.stderr
    assert "worktree-work" not in git_out(repo, "branch", "--format=%(refname:short)")


def test_a_worktree_outside_the_sessions_directory_is_never_removed(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # A tree somebody made by hand is not this sweep's to delete, landed and clean
    # or not.
    repo = _repo(tmp_path)
    elsewhere = tmp_path / "by-hand"
    git(repo, "worktree", "add", "-q", "-b", "worktree-by-hand", str(elsewhere))
    commit(elsewhere, "work", **{"b.txt": "two\n"})
    _land_branches(repo, "worktree-by-hand")

    done = _main(repo, monkeypatch, capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert elsewhere.is_dir()
    assert str(elsewhere) not in done.stdout


def test_a_fresh_tree_at_the_bases_tip_survives_a_prune(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    # Its branch is an ancestor of the base only because the session has not committed
    # yet, and removing the tree would pull it out from under that session.
    repo = _repo(tmp_path)
    tree = session_tree(repo, "starting", "worktree-starting")

    listed = _main(repo, monkeypatch, capsys, "--all")
    done = _main(repo, monkeypatch, capsys, "--prune")

    assert "worktree-starting has no commits of its own yet" in listed.stdout
    assert done.returncode == 0, done.stderr
    assert tree.is_dir()
    assert "worktree-starting" in git_out(repo, "branch", "--format=%(refname:short)")


# --- the sweep lock -------------------------------------------------------------------


def _hold_lock(repo: Path) -> int:
    fcntl = pytest.importorskip("fcntl")
    fd = os.open(
        repo / ".git" / claude_worktree_sweep.PRUNE_LOCK, os.O_RDWR | os.O_CREAT, 0o644
    )
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def test_prune_gives_up_on_a_lock_that_stays_held_and_exits_75(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    monkeypatch.setattr(claude_worktree_sweep, "LOCK_WAIT_S", 0.6)
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "done")
    _land_branches(repo, "worktree-done")
    fd = _hold_lock(repo)
    try:
        started = time.monotonic()
        done = _main(repo, monkeypatch, capsys, "--prune")
        waited = time.monotonic() - started
    finally:
        os.close(fd)

    assert done.returncode == 75
    assert waited >= 0.6
    assert "nothing was pruned" in done.stderr
    assert tree.is_dir()


def test_prune_waits_for_a_lock_and_runs_once_it_is_free(
    tmp_path, monkeypatch, capsys, own_processes_only
):
    monkeypatch.setattr(claude_worktree_sweep, "LOCK_WAIT_S", 10.0)
    repo = _repo(tmp_path)
    tree = _work_tree(repo, "done")
    _land_branches(repo, "worktree-done")
    fd = _hold_lock(repo)
    release = threading.Timer(0.7, os.close, args=(fd,))
    release.start()
    try:
        done = _main(repo, monkeypatch, capsys, "--prune")
    finally:
        release.join()

    assert done.returncode == 0, done.stderr
    assert not tree.exists()


# --- the launcher ---------------------------------------------------------------------


def _launcher(repo: Path, home: Path, *argv: str) -> subprocess.CompletedProcess:
    env = scrubbed_env(
        CLAUDE_WORKTREE_HOME=str(home),
        CLAUDE_CONFIG_DIR=str(repo.parent / "claude-config"),
        GH_BIN="true",
    )
    env.pop("PYTHONPATH", None)
    return subprocess.run(
        [sys.executable, str(LAUNCHER), *argv],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
    )


def test_the_launcher_reaches_main_in_the_package_it_is_pointed_at(tmp_path):
    repo = _repo(tmp_path)

    done = _launcher(repo, PACKAGE, "--check", "master")

    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "master: landed (ancestry)"


def test_the_launcher_exits_69_when_the_package_is_missing(tmp_path):
    repo = _repo(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()

    done = _launcher(repo, empty, "--prune")

    assert done.returncode == 69
    assert done.stderr.startswith("prune-worktrees: ")
    assert f"`chezmoi apply` deploys {empty}" in done.stderr
    assert done.stdout == ""


def test_the_launcher_under_hook_lets_the_session_start_without_the_package(tmp_path):
    repo = _repo(tmp_path)
    empty = tmp_path / "empty"
    empty.mkdir()

    done = _launcher(repo, empty, "--hook")

    assert done.returncode == 0, done.stderr
    assert done.stdout.startswith("worktree autoprune skipped: ")
