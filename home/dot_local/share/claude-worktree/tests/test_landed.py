"""Tests for the landed ladder: its layers, the verdict cache, the forge layer.

Real git in scratch repositories; the forge is a stub reached through `GH_BIN` or a
callable passed as `forge=`.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

from pathlib import Path
from types import SimpleNamespace

import claude_worktree
from _repo import commit, git, init_repo
from claude_worktree import (
    VERDICT_CACHE,
    contained_in_merged_pr,
    drop_dead_verdicts,
    forge_confirms,
    local_layer,
    merge_tree,
    merged_layer,
    read_verdicts,
    record_verdict,
    verdict_cache_path,
    verdict_key,
)

TIP = "a" * 40
MERGED_HEAD = "f" * 40


def _scratch_repo(tmp_path: Path) -> Path:
    repo = init_repo(tmp_path / "repo")
    commit(repo, "init", **{"a.txt": "one\n"})
    return repo


def _unmerged_branch(tmp_path: Path) -> tuple[Path, str]:
    """A repo whose `feature` branch has a commit master lacks, and that SHA."""
    repo = _scratch_repo(tmp_path)
    git(repo, "checkout", "-q", "-b", "feature")
    head = commit(repo, "feature work", **{"b.txt": "two\n"})
    git(repo, "checkout", "-q", "master")
    return repo, head


def _never_asked(*_args) -> bool:
    raise AssertionError("the forge was asked for a verdict the cache holds")


# --- the layers, in the order the ladder asks them ------------------------------------


def test_an_ancestor_head_is_landed_by_ancestry_without_asking_the_forge(tmp_path):
    repo = _scratch_repo(tmp_path)
    head = git(repo, "rev-parse", "HEAD").stdout.strip()

    assert (
        merged_layer(str(repo), head, "feature", "master", _never_asked) == "ancestry"
    )


def test_a_cherry_picked_branch_is_landed_by_patch_id(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    commit(repo, "master moves on", **{"c.txt": "three\n"})
    git(repo, "cherry-pick", head)

    assert (
        merged_layer(str(repo), head, "feature", "master", _never_asked) == "patch-id"
    )


# --- the verdict cache ----------------------------------------------------------------


def test_a_recorded_verdict_answers_the_next_call_without_recomputing(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    assert merged_layer(str(repo), head, "feature", "master", lambda *_: False) is None
    key = verdict_key(str(repo), head, "master")
    assert key is not None
    assert read_verdicts(str(repo))[key] == ""
    # A value git would never compute for this pair, so only the file can answer.
    record_verdict(str(repo), key, "content")
    assert merged_layer(str(repo), head, "feature", "master", _never_asked) == "content"


def test_a_forge_merged_answer_is_recorded_and_not_asked_again(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    assert (
        merged_layer(str(repo), head, "feature", "master", lambda *_: True) == "forge"
    )
    assert merged_layer(str(repo), head, "feature", "master", _never_asked) == "forge"


def test_a_forge_not_merged_answer_is_trusted_only_until_it_expires(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    assert merged_layer(str(repo), head, "feature", "master", lambda *_: False) is None
    assert merged_layer(str(repo), head, "feature", "master", _never_asked) is None
    # Epoch 0 is far past FORGE_NO_TTL_S, so the forge must be asked again, and
    # now says merged.
    record_verdict(str(repo), f"forge-no:{head}:feature", "0")
    assert (
        merged_layer(str(repo), head, "feature", "master", lambda *_: True) == "forge"
    )


def test_a_forge_that_did_not_ask_records_nothing(tmp_path):
    # A caller whose time budget ran out answers None. Recording it as a "no" would
    # keep a merged tree for the whole trust window.
    repo, head = _unmerged_branch(tmp_path)
    key = verdict_key(str(repo), head, "master")

    assert not forge_confirms(str(repo), head, "feature", "master", lambda *_: None)

    assert read_verdicts(str(repo)) == {}
    assert forge_confirms(str(repo), head, "feature", "master", lambda *_: True)
    assert read_verdicts(str(repo))[key] == "forge"


def test_a_dead_head_loses_its_verdicts_and_a_live_head_keeps_them(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    base = git(repo, "rev-parse", "master").stdout.strip()
    dead = "d" * 40
    record_verdict(str(repo), f"{head}:{base}", "ancestry")
    record_verdict(str(repo), f"forge-no:{head}:feature", "123")
    record_verdict(str(repo), f"{dead}:{base}", "")
    record_verdict(str(repo), f"forge-no:{dead}:feature", "123")

    drop_dead_verdicts(str(repo), {head})

    assert set(read_verdicts(str(repo))) == {
        f"{head}:{base}",
        f"forge-no:{head}:feature",
    }


def test_a_corrupt_cache_file_reads_as_empty_and_is_replaced(tmp_path):
    repo, head = _unmerged_branch(tmp_path)
    path, key = verdict_cache_path(str(repo)), verdict_key(str(repo), head, "master")
    assert path is not None and key is not None
    path.write_text("{not json")
    assert merged_layer(str(repo), head, "feature", "master", lambda *_: False) is None
    assert read_verdicts(str(repo))[key] == ""


def test_the_cache_lives_in_the_git_common_dir_not_a_worktree(tmp_path):
    repo = _scratch_repo(tmp_path)
    wt = tmp_path / "wt"
    git(repo, "worktree", "add", "-q", "-b", "feature", str(wt))
    expected = repo.resolve() / ".git" / VERDICT_CACHE
    assert verdict_cache_path(str(wt)) == expected
    assert verdict_cache_path(str(repo)) == expected


def _cherry_calls(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []
    real = claude_worktree.git

    def spy(*args, **kwargs):
        if args[0] == "cherry":
            calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(claude_worktree, "git", spy)
    return calls


def test_a_base_move_that_carries_none_of_the_branchs_patches_skips_cherry(
    tmp_path, monkeypatch
):
    repo, head = _unmerged_branch(tmp_path)
    assert local_layer(str(repo), head, "master") is None
    commit(repo, "master moves on", **{"c.txt": "three\n"})
    calls = _cherry_calls(monkeypatch)

    assert local_layer(str(repo), head, "master") is None

    assert calls == []
    assert read_verdicts(str(repo))[verdict_key(str(repo), head, "master")] == ""


def test_a_base_move_that_carries_the_branchs_patch_is_rechecked_as_landed(
    tmp_path, monkeypatch
):
    repo, head = _unmerged_branch(tmp_path)
    assert local_layer(str(repo), head, "master") is None
    commit(repo, "master moves on", **{"c.txt": "three\n"})
    git(repo, "cherry-pick", head)
    calls = _cherry_calls(monkeypatch)

    assert local_layer(str(repo), head, "master") == "patch-id"

    assert len(calls) == 1


def test_a_base_move_that_touches_the_branchs_files_is_rechecked(tmp_path, monkeypatch):
    repo, head = _unmerged_branch(tmp_path)
    assert local_layer(str(repo), head, "master") is None
    commit(repo, "master adds the file in two steps", **{"b.txt": "x\n"})
    commit(repo, "master finishes the file", **{"b.txt": "two\n"})
    calls = _cherry_calls(monkeypatch)

    assert local_layer(str(repo), head, "master") == "content"

    assert len(calls) == 1


def test_a_base_that_is_not_a_descendant_of_the_old_one_is_rechecked(
    tmp_path, monkeypatch
):
    repo, head = _unmerged_branch(tmp_path)
    assert local_layer(str(repo), head, "master") is None
    git(repo, "reset", "-q", "--hard", "HEAD~0")
    git(repo, "commit", "-q", "--amend", "-m", "init, rewritten")
    calls = _cherry_calls(monkeypatch)

    assert local_layer(str(repo), head, "master") is None

    assert len(calls) == 1


# --- the content check ----------------------------------------------------------------


def _loose_objects(repo: Path) -> set[Path]:
    return set((repo / ".git" / "objects").glob("??/*"))


def test_the_content_check_writes_nothing_into_the_object_store(tmp_path):
    # An unlanded branch's merge result is computed, then thrown away. Every base
    # advance re-asks this for every unlanded worktree, so a result left behind as
    # loose objects fills the primary checkout's store faster than gc clears it.
    repo, head = _unmerged_branch(tmp_path)
    commit(repo, "master moves on", **{"c.txt": "three\n"})
    before = _loose_objects(repo)

    assert merged_layer(str(repo), head, "feature", "master", lambda *_: False) is None

    assert _loose_objects(repo) == before


def test_the_content_check_still_finds_a_squash_merged_branch(tmp_path):
    # The scratch object store still reads both commits through the real one. Master
    # holds the branch's content under a different commit, so only merge-tree sees it.
    # A contained merge's result is master's own tree, already in the store, so this
    # cannot be made to fail by a store that writes nothing.
    repo, head = _unmerged_branch(tmp_path)
    commit(
        repo, "squash of feature, plus more", **{"b.txt": "two\n", "c.txt": "three\n"}
    )

    assert merged_layer(str(repo), head, "feature", "master", _never_asked) == "content"


def test_a_conflicting_merge_from_a_linked_worktree_keeps_exit_1_and_writes_nothing(
    tmp_path,
):
    # The scratch store reads through the SHARED objects directory, which a linked
    # worktree's own git dir lacks. Exit 1 is what tells a conflict from a failure.
    repo, wt = _scratch_repo(tmp_path), tmp_path / "wt"
    git(repo, "worktree", "add", "-q", "-b", "feature", str(wt))
    commit(wt, "feature side", **{"a.txt": "feature\n"})
    commit(repo, "master side", **{"a.txt": "master\n"})
    before = _loose_objects(repo)

    result = merge_tree("master", "feature", cwd=wt)

    assert result.returncode == 1, result.stderr
    assert "a.txt" in result.stdout
    assert _loose_objects(repo) == before


# --- the forge layer ------------------------------------------------------------------


def _contained(merged_heads: str, compare: str) -> bool:
    """`contained_in_merged_pr` with a gh whose `pr list` prints `merged_heads`.

    Its `api` call prints `compare`.
    """

    def fake_gh(*args, **_kwargs):
        out = compare if args[0] == "api" else merged_heads
        return SimpleNamespace(returncode=0, stdout=out)

    return contained_in_merged_pr("/repo", TIP, "worktree-fanout-b", fake_gh)


def test_a_tip_inside_the_merged_pr_head_has_landed():
    assert _contained(MERGED_HEAD + "\n", "ahead\n")


def test_a_diverged_tip_has_not_landed():
    # Local commits the merged head lacks are work nothing proves landed.
    assert not _contained(MERGED_HEAD + "\n", "diverged\n")


def test_a_branch_with_no_merged_pr_has_not_landed():
    assert not _contained("", "ahead\n")


def test_the_ladder_counts_a_branch_the_lander_extended_before_the_merge(
    tmp_path, monkeypatch
):
    # `land.sh` merges the base into a batch branch before it merges the PR, so the
    # merged head is the local tip plus a merge commit. No local layer settles the
    # branch and the forge's exact match fails; the compare against the merged head is
    # what lands it.
    repo, head = _unmerged_branch(tmp_path)
    commit(repo, "master moves on", **{"c.txt": "three\n"})
    gh = tmp_path / "gh"
    gh.write_text(
        f'#!/bin/sh\ncase "$1" in\n  pr) echo {MERGED_HEAD} ;;\n'
        "  api) echo ahead ;;\nesac\n"
    )
    gh.chmod(0o755)
    monkeypatch.setenv("GH_BIN", str(gh))

    assert merged_layer(str(repo), head, "feature", "master") == "forge"
