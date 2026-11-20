"""Tests for which session branches the sweep deletes: `judge_branches`,
`delete_branch`, `--check`.

Real git throughout. The forge is `GH_BIN`: `true` answers every read with nothing,
which is a forge with no pull requests, and `false` fails every read.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import claude_worktree
import claude_worktree_sweep
import pytest
from _repo import commit, git, git_out, init_repo, land
from claude_worktree_sweep import (
    FRESH,
    HELD,
    HOLDS_UNREAD,
    REPO_HOLDS,
    REVIEWABLE,
    UNLANDED,
    Sweep,
    delete_branch,
    judge_branches,
    read_policy,
)


def _landed_branch(repo: Path, name: str) -> None:
    """A branch behind master, then moved onto it: an ancestor, and not fresh."""
    git(repo, "branch", name, "master~1")
    git(repo, "branch", "-f", name, "master")


def _rebase_landed(repo: Path, name: str) -> str:
    """A branch whose commit reached master as a cherry-pick; `-d` refuses it."""
    git(repo, "switch", "-q", "-c", name)
    commit(repo, "rebased work", **{"c.txt": "three\n"})
    git(repo, "switch", "-q", "master")
    git(repo, "cherry-pick", "-x", name)
    land(repo, "master")
    return git_out(repo, "rev-parse", name)


def _write_policy(repo: Path, policy: object) -> None:
    path = repo / ".claude" / "prune-worktrees.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(policy))


@pytest.fixture
def repo(tmp_path: Path, monkeypatch, own_processes_only) -> Path:
    """A repo with a landed orphan, an unlanded and a held `claude/` branch.

    The held worktree is dirty and outside `.claude/worktrees/`, so a prune keeps both
    it and its branch. The policy lets the branch sweep touch `claude/` as well.
    """
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    repo = init_repo(tmp_path / "repo")
    commit(repo, "init", **{"a.txt": "one\n"})
    commit(repo, "second", **{"a.txt": "two\n"})
    (repo / ".git" / "info" / "exclude").write_text(".claude/\n")
    _landed_branch(repo, "claude/landed")
    git(repo, "switch", "-q", "-c", "claude/unlanded")
    commit(repo, "open work", **{"b.txt": "two\n"})
    git(repo, "switch", "-q", "master")
    git(repo, "worktree", "add", "-q", "-b", "claude/held", str(tmp_path / "held"))
    (tmp_path / "held" / "wip.txt").write_text("uncommitted\n")
    land(repo, "master")
    _write_policy(repo, {"branch_prefixes": ["worktree-", "claude/"]})
    monkeypatch.chdir(repo)
    return repo


def _main(capsys, *argv: str) -> subprocess.CompletedProcess:
    capsys.readouterr()
    code = claude_worktree_sweep.main(list(argv))
    out, err = capsys.readouterr()
    return subprocess.CompletedProcess(argv, code, out, err)


def _branches(repo: Path) -> list[str]:
    return git_out(repo, "branch", "--format=%(refname:short)").split()


def _sweep(repo: Path, **fields) -> Sweep:
    return Sweep(
        repo=str(repo),
        base=claude_worktree.default_ref(str(repo)) or "",
        policy=read_policy(str(repo)),
        **fields,
    )


def _judged(
    repo: Path, sweep: Sweep | None = None, **seams
) -> dict[str, tuple[bool, str]]:
    verdicts = judge_branches(sweep or _sweep(repo), **seams)
    return {v.branch: (v.delete, v.reason) for v in verdicts}


def test_a_prune_deletes_the_landed_orphan_and_keeps_the_held_and_the_unlanded(
    repo, capsys
):
    done = _main(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert _branches(repo) == ["claude/held", "claude/unlanded", "master"]
    assert "deleted claude/landed" in done.stdout


def test_the_judge_sees_only_session_branches_and_names_the_held_one(repo):
    # feature-landed is outside the prefixes though it is landed; master is held by the
    # primary checkout, and claude/held by its worktree.
    git(repo, "branch", "feature-landed")

    assert _judged(repo) == {
        "claude/held": (False, HELD),
        "claude/landed": (True, "landed by ancestry"),
        "claude/unlanded": (False, UNLANDED),
    }


def test_an_unmerged_session_branch_is_never_swept(repo, capsys):
    # claude/unlanded carries a commit master lacks, so no local layer settles it and it
    # survives a sweep that deletes its neighbour.
    git(repo, "branch", "worktree-open", "claude/unlanded")

    done = _main(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert "claude/unlanded" in _branches(repo)
    assert "worktree-open" in _branches(repo)
    assert "claude/landed" not in _branches(repo)


@pytest.mark.parametrize(
    ("holds", "reason"),
    [
        (lambda repo, command: {"claude/landed"}, REPO_HOLDS),
        (lambda repo, command: None, HOLDS_UNREAD),
    ],
    ids=["named", "unread"],
)
def test_a_landed_orphan_the_repo_names_or_cannot_be_asked_about_is_kept(
    repo, holds, reason
):
    assert _judged(repo)["claude/landed"] == (True, "landed by ancestry")
    assert _judged(repo, holds=holds)["claude/landed"] == (False, reason)


@pytest.mark.parametrize(
    ("forge_answer", "verdict"),
    [(True, (True, "landed by forge")), (False, (False, UNLANDED))],
)
def test_a_branch_no_local_layer_settles_is_deleted_only_on_the_forges_word(
    repo, forge_answer, verdict
):
    # claude/unlanded stands for a squash-merged branch master drifted from. A forge
    # read that failed answers False, the same as "not merged".
    sweep = _sweep(repo, forge=lambda *_: forge_answer)

    assert _judged(repo, sweep)["claude/unlanded"] == verdict


def _holds_script(tmp_path: Path, body: str) -> list[str]:
    script = tmp_path / "holds.py"
    script.write_text(body)
    return [sys.executable, str(script)]


def test_a_branch_the_holds_command_prints_is_kept(repo, tmp_path, capsys):
    _landed_branch(repo, "worktree-extra")
    command = _holds_script(tmp_path, "print('claude/landed')\nprint('  ')\n")
    _write_policy(
        repo, {"branch_prefixes": ["worktree-", "claude/"], "branch_holds": command}
    )

    judged = _judged(repo)
    done = _main(capsys, "--prune")

    assert judged["claude/landed"] == (False, REPO_HOLDS)
    assert judged["worktree-extra"] == (True, "landed by ancestry")
    assert done.returncode == 0, done.stderr
    assert "claude/landed" in _branches(repo)
    assert "worktree-extra" not in _branches(repo)


def test_a_holds_command_that_fails_keeps_every_landed_branch(repo, tmp_path, capsys):
    command = _holds_script(
        tmp_path, "import sys\nprint('claude/other')\nsys.exit(3)\n"
    )
    _write_policy(
        repo, {"branch_prefixes": ["worktree-", "claude/"], "branch_holds": command}
    )

    done = _main(capsys, "--prune")

    assert done.returncode == 0, done.stderr
    assert "claude/landed" in _branches(repo)
    assert f"kept 1 landed branch(es): {HOLDS_UNREAD}" in done.stderr
    assert _judged(repo)["claude/landed"] == (False, HOLDS_UNREAD)


def test_a_holds_command_that_cannot_start_keeps_every_landed_branch(repo):
    _write_policy(
        repo,
        {"branch_prefixes": ["worktree-", "claude/"], "branch_holds": ["/no/such/cmd"]},
    )

    assert _judged(repo)["claude/landed"] == (False, HOLDS_UNREAD)


def test_a_rebase_landed_branch_is_reviewed_unless_the_policy_lets_patch_id_act(repo):
    _rebase_landed(repo, "worktree-rebased")

    assert _judged(repo)["worktree-rebased"] == (False, REVIEWABLE)
    _write_policy(repo, {"branch_prefixes": ["worktree-"], "landed_by": ["patch-id"]})
    assert _judged(repo)["worktree-rebased"] == (True, "landed by patch-id")


def test_a_rebase_landed_branch_is_deleted_though_git_branch_d_refuses_it(repo):
    # The commit's content is on master under another SHA, so the tip is not an ancestor
    # and `-d` says "not fully merged".
    head = _rebase_landed(repo, "worktree-rebased")

    assert git(repo, "branch", "-d", "worktree-rebased", check=False).returncode != 0
    ok, error = delete_branch(str(repo), "worktree-rebased", head)

    assert ok, error
    assert "worktree-rebased" not in _branches(repo)


def test_delete_branch_leaves_a_branch_that_moved_since_it_was_judged(repo):
    judged_head = _rebase_landed(repo, "worktree-rebased")
    git(repo, "switch", "-q", "worktree-rebased")
    commit(repo, "work made after the verdict", **{"d.txt": "four\n"})
    git(repo, "switch", "-q", "master")

    ok, error = delete_branch(str(repo), "worktree-rebased", judged_head)

    assert not ok
    assert "moved since it was judged" in error
    assert "worktree-rebased" in _branches(repo)


def test_delete_branch_takes_the_ancestry_landed_branch_with_branch_d(repo):
    head = git_out(repo, "rev-parse", "claude/landed")

    assert delete_branch(str(repo), "claude/landed", head) == (True, "")
    assert "claude/landed" not in _branches(repo)


def test_a_branch_cut_at_the_bases_tip_and_never_moved_is_kept_as_fresh(repo):
    # A session's branch is an ancestor of the base until its first commit.
    git(repo, "branch", "worktree-new")

    assert _judged(repo)["worktree-new"] == (False, FRESH)


def test_a_bare_check_lists_the_deletions_and_counts_the_kept(repo, capsys):
    _landed_branch(repo, "worktree-landed")

    done = _main(capsys, "--check")

    assert done.returncode == 0, done.stderr
    assert done.stdout.splitlines() == [
        "4 session branch(es): 2 would be deleted (landed by ancestry), "
        f"1 kept ({HELD}), 1 kept ({UNLANDED}); --all lists the kept",
        "worktree-*: 1 would be deleted (landed by ancestry)",
        "claude/*: 1 would be deleted (landed by ancestry), "
        f"1 kept ({HELD}), 1 kept ({UNLANDED})",
        "would be deleted (landed by ancestry):",
        "  claude/landed",
        "  worktree-landed",
    ]
    assert "claude/landed" in _branches(repo)


def test_check_all_lists_the_kept_branches_too(repo, capsys):
    done = _main(capsys, "--check", "--all")

    assert done.returncode == 0, done.stderr
    assert f"kept ({HELD}):\n  claude/held" in done.stdout
    assert f"kept ({UNLANDED}):\n  claude/unlanded" in done.stdout
    assert "--all lists the kept" not in done.stdout


def test_the_brief_report_counts_only_what_the_bulk_ancestry_layer_settles(
    repo, capsys
):
    # The banner's budget is the constraint, so it counts what one `git branch --merged`
    # settles and nothing more. Asserted by what it MISSES: a rebase-landed branch is
    # exactly the case only the per-branch layers reach, even where the policy lets
    # patch-id act.
    _rebase_landed(repo, "worktree-rebased")
    _write_policy(
        repo,
        {"branch_prefixes": ["worktree-", "claude/"], "landed_by": ["patch-id"]},
    )

    done = _main(capsys, "--brief")

    assert done.returncode == 0, done.stderr
    assert done.stdout.splitlines() == [
        "WARN: 1 orphan session branch(es) already on origin/master",
        f"  → {claude_worktree_sweep.COMMAND} --prune",
    ]
    assert _judged(repo)["worktree-rebased"] == (True, "landed by patch-id")
