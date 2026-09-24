"""Tests for the shared worktree readers.

Each reader takes text and returns a verdict, so nothing here needs a fixture repository
except `default_ref`, which runs a single read-only git query.

Run: PYTHONPATH=. uv run --no-project --with pytest pytest
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import claude_worktree
import pytest
from claude_worktree import (
    Worktree,
    cherry_says_landed,
    default_ref,
    forge_says_merged,
    merge_tree_says_contained,
    parse_worktree_list,
    pr_head_says_merged,
    session_is_alive,
)

# --- session_is_alive ---------------------------------------------------------------

# session_is_alive compares a start time against /proc/<pid>/stat, so it reaches a real
# verdict only where /proc exists. On macOS the read raises OSError and the function
# answers False for every parseable reason: the two "reads as dead" tests below would
# pass without exercising the start-time comparison they are named for, and the "reads
# as alive" one would fail. Skip all three there rather than assert a verdict the
# platform did not produce. The module-level read is guarded by the same flag:
# unguarded, it raised at import and took the whole file down during collection.
HAVE_PROC = Path("/proc/self/stat").exists()
linux_only = pytest.mark.skipif(not HAVE_PROC, reason="session_is_alive reads /proc")

MY_PID = os.getpid()
MY_START = (
    Path(f"/proc/{MY_PID}/stat").read_text().rpartition(")")[2].split()[19]
    if HAVE_PROC
    else ""
)


@linux_only
def test_a_lock_held_by_a_running_process_reads_as_alive():
    assert session_is_alive(f"claude session x (pid {MY_PID} start {MY_START})")


@linux_only
def test_a_reused_pid_with_a_different_start_time_reads_as_dead():
    assert not session_is_alive(f"claude session x (pid {MY_PID} start 1)")


@linux_only
def test_a_vanished_pid_reads_as_dead():
    assert not session_is_alive("claude session x (pid 4194303 start 12345)")


@pytest.mark.parametrize("reason", ["locked by hand while I debug this", ""])
def test_an_unparseable_lock_reason_is_treated_as_live(reason):
    assert session_is_alive(reason)


# --- parse_worktree_list ------------------------------------------------------------

PORCELAIN = (
    "worktree /repo\nHEAD aaa\nbranch refs/heads/master\n\n"
    "worktree /repo/.claude/worktrees/one\nHEAD bbb\nbranch refs/heads/wt-one\n"
    "locked claude session one (pid 7 start 9)\n\n"
    "worktree /repo/.claude/worktrees/two\nHEAD ccc\ndetached\n"
)


def test_parses_every_worktree_including_the_last():
    trees = parse_worktree_list(PORCELAIN)
    assert [t.path for t in trees] == [
        "/repo",
        "/repo/.claude/worktrees/one",
        "/repo/.claude/worktrees/two",
    ]
    assert trees[0] == Worktree("/repo", "aaa", "master", False, "")


def test_strips_the_refs_heads_prefix_from_branches():
    assert parse_worktree_list(PORCELAIN)[1].branch == "wt-one"


def test_detached_worktree_has_no_branch():
    assert parse_worktree_list(PORCELAIN)[2].branch is None


def test_reads_the_lock_marker_and_its_reason():
    tree = parse_worktree_list(PORCELAIN)[1]
    assert tree.locked
    assert tree.lock_reason == "claude session one (pid 7 start 9)"


def test_a_bare_locked_line_still_counts_as_locked():
    tree = parse_worktree_list("worktree /w\nHEAD abc\nbranch refs/heads/b\nlocked\n")[
        0
    ]
    assert tree.locked
    assert tree.lock_reason == ""


# --- cherry_says_landed -------------------------------------------------------------


def test_every_commit_upstream_reads_as_landed():
    assert cherry_says_landed("- abc\n- def\n", empty_means=False)


def test_a_commit_the_target_lacks_is_not_landed():
    assert not cherry_says_landed("- abc\n+ def\n", empty_means=True)


def test_blank_lines_do_not_change_the_verdict():
    assert cherry_says_landed("\n- abc\n\n", empty_means=False)


# The red-proof pair for `empty_means`: the two callers need opposite verdicts on empty
# output, and a default would delete a fresh worktree on one side or keep a merged one
# forever on the other. Both directions are pinned so a hardcoded answer fails one.
def test_empty_output_reads_as_the_caller_says_when_true():
    assert cherry_says_landed("", empty_means=True)


def test_empty_output_reads_as_the_caller_says_when_false():
    assert not cherry_says_landed("", empty_means=False)


def test_empty_means_is_keyword_only():
    with pytest.raises(TypeError):
        cherry_says_landed("", True)  # type: ignore[misc]


# --- merge_tree_says_contained ------------------------------------------------------


def test_a_merge_that_changes_nothing_is_contained():
    assert merge_tree_says_contained("abc123\n", "abc123")


def test_a_merge_that_would_change_the_target_is_not_contained():
    assert not merge_tree_says_contained("abc123\n", "def456")


def test_only_the_first_line_is_the_tree():
    # A conflicted merge-tree prints the tree OID first, then the conflicted paths.
    assert merge_tree_says_contained("abc123\nsome/path\n", "abc123")


@pytest.mark.parametrize(
    ("stdout", "target"), [("", "abc123"), ("abc123\n", ""), ("", "")]
)
def test_missing_input_is_no_verdict(stdout, target):
    assert not merge_tree_says_contained(stdout, target)


# --- default_ref --------------------------------------------------------------------


def _git(*args, cwd):
    # Scrub GIT_DIR/GIT_WORK_TREE: under a git hook they outrank cwd and would aim these
    # writes at the real repository the hook fired in.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path):
    _git("init", "-q", "-b", "trunk", cwd=tmp_path)
    _git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "root",
        cwd=tmp_path,
    )
    return tmp_path


def test_default_ref_reads_origin_head(repo):
    _git("update-ref", "refs/remotes/origin/trunk", "HEAD", cwd=repo)
    _git(
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/trunk",
        cwd=repo,
    )
    assert default_ref(str(repo)) == "origin/trunk"


def test_default_ref_guesses_main_then_master_without_origin_head(repo):
    _git("update-ref", "refs/remotes/origin/master", "HEAD", cwd=repo)
    assert default_ref(str(repo)) == "origin/master"
    _git("update-ref", "refs/remotes/origin/main", "HEAD", cwd=repo)
    assert default_ref(str(repo)) == "origin/main"


def test_default_ref_is_none_with_no_merge_target(repo):
    assert default_ref(str(repo)) is None


# --- pr_head_says_merged: the forge settles what a drifted squash merge cannot -------


def test_pr_head_matching_the_tip_reads_as_merged():
    tip = "aaaa111"
    assert pr_head_says_merged(f'[{{"headRefOid": "{tip}"}}]', tip)


def test_pr_head_from_a_different_tip_does_not_read_as_merged():
    # A reused branch name: two merged PRs, neither from this tip.
    stdout = '[{"headRefOid": "aaaa111"}, {"headRefOid": "bbbb222"}]'
    assert not pr_head_says_merged(stdout, "cccc333")


def test_pr_head_with_no_merged_prs_does_not_read_as_merged():
    assert not pr_head_says_merged("[]", "aaaa111")


def test_pr_head_survives_gh_returning_nothing():
    assert not pr_head_says_merged("", "aaaa111")


def test_pr_head_survives_malformed_json():
    assert not pr_head_says_merged("not json at all", "aaaa111")


def test_pr_head_survives_json_that_is_not_a_list():
    assert not pr_head_says_merged('{"headRefOid": "aaaa111"}', "aaaa111")


# --- forge_says_merged: one bounded, memoised `gh pr list` ----------------------------


@pytest.fixture
def gh_stub(tmp_path, monkeypatch):
    """A `gh` that answers `pr list --head <b>` from a table and counts its calls.

    Returns (set_merged, calls): set_merged takes (branch, head) rows, and calls() is
    how many times the stub ran. The memo is cleared so each test starts cold.
    """
    table = tmp_path / "merged.json"
    count = tmp_path / "calls"
    table.write_text("[]")
    stub = tmp_path / "gh"
    stub.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"open({str(count)!r}, 'a').write('x\\n')\n"
        "branch = sys.argv[sys.argv.index('--head') + 1]\n"
        f"rows = json.load(open({str(table)!r}))\n"
        "print(json.dumps([{'headRefOid': h} for b, h in rows if b == branch]))\n"
    )
    stub.chmod(0o755)
    monkeypatch.setenv("GH_BIN", str(stub))
    monkeypatch.setattr(claude_worktree, "_FORGE_MEMO", {})

    def set_merged(*rows):
        table.write_text(json.dumps(rows))

    def calls():
        return len(count.read_text().splitlines()) if count.exists() else 0

    return set_merged, calls


def test_forge_says_merged_when_a_merged_pr_has_this_head(gh_stub, tmp_path):
    set_merged, _ = gh_stub
    set_merged(("worktree-x", "aaaa111"))
    assert forge_says_merged(str(tmp_path), "worktree-x", "aaaa111")


def test_forge_does_not_say_merged_for_another_tip_of_a_reused_name(gh_stub, tmp_path):
    set_merged, _ = gh_stub
    set_merged(("worktree-x", "aaaa111"))
    assert not forge_says_merged(str(tmp_path), "worktree-x", "bbbb222")


def test_forge_failure_reads_as_not_merged(monkeypatch, tmp_path):
    monkeypatch.setattr(claude_worktree, "_FORGE_MEMO", {})
    monkeypatch.setenv("GH_BIN", str(tmp_path / "no-such-gh"))
    assert not forge_says_merged(str(tmp_path), "worktree-x", "aaaa111")
    monkeypatch.setenv("GH_BIN", "false")
    assert not forge_says_merged(str(tmp_path), "worktree-y", "aaaa111")


def test_forge_asks_once_per_branch_and_head(gh_stub, tmp_path):
    set_merged, calls = gh_stub
    set_merged(("worktree-x", "aaaa111"))
    for _ in range(3):
        assert forge_says_merged(str(tmp_path), "worktree-x", "aaaa111")
    assert calls() == 1


def test_forge_merged_command_exits_zero_only_on_a_match(gh_stub, tmp_path):
    set_merged, _ = gh_stub
    set_merged(("worktree-x", "aaaa111"))
    script = Path(claude_worktree.__file__)

    def run(*args):
        return subprocess.run(
            [sys.executable, str(script), *args], cwd=tmp_path, check=False
        ).returncode

    assert run("forge-merged", "worktree-x", "aaaa111") == 0
    assert run("forge-merged", "worktree-x", "bbbb222") == 1
    assert run("forge-merged") == 2
