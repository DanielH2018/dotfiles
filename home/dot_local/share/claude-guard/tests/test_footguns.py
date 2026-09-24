"""The four host-generic footgun rules ported from the server repo's block-footguns.py.

Each rule has the red half it exists for and the green half it must leave alone; the
server's own pairs for these rules moved here with them (dotfiles #628).
"""

import json

import pytest

from claude_guard import footguns
from claude_guard.deny import NONE, Verdict
from claude_guard.footguns import footgun
from claude_guard.hook import merge, pre_tool_use


def rule(command: str) -> str | None:
    verdict = footgun(command)
    return verdict.rule if verdict else None


@pytest.fixture
def ugrep(monkeypatch):
    monkeypatch.setattr(footguns, "_grep_is_ugrep", lambda: True)


@pytest.fixture
def gnu_grep(monkeypatch):
    monkeypatch.setattr(footguns, "_grep_is_ugrep", lambda: False)


# --- 1. ugrep's -Z and -z ---------------------------------------------------------------


def test_grep_dash_Z_is_denied_where_grep_is_ugrep(ugrep):
    assert rule("grep -Z foo .") == "ugrep-flag"


def test_a_bundled_dash_Z_is_denied_where_grep_is_ugrep(ugrep):
    """The incident was written `grep -lZ ... | xargs -0`, so bundling must be unbundled."""
    assert rule("grep -rlZ foo . | xargs -0 sed -i s/a/b/") == "ugrep-flag"


def test_grep_dash_z_is_denied_where_grep_is_ugrep(ugrep):
    assert "--null-data" in footgun("grep -z foo file").reason


def test_grep_with_null_is_clean(ugrep):
    assert footgun("grep -rl --null foo .") is None


def test_a_dash_Z_on_another_binary_is_clean(ugrep):
    assert footgun("sort -Z file") is None


def test_grep_dash_Z_is_clean_where_grep_is_gnu(gnu_grep):
    """On GNU grep `-Z` IS the NUL separator; denying it there would be the false positive."""
    assert footgun("grep -rlZ foo . | xargs -0 wc -l") is None


# --- 2. a bare git stash pop ------------------------------------------------------------


def test_bare_stash_pop_is_denied():
    assert "per-repository" in footgun("git stash pop").reason


def test_bare_stash_apply_is_denied():
    assert rule("git stash apply") == "bare-stash"


def test_stash_pop_behind_a_negation_is_denied():
    """A negation is what someone writes when they expect the pop to fail."""
    assert rule("! git stash pop") == "bare-stash"


def test_stash_pop_in_a_later_stage_is_denied():
    assert rule("git fetch; git stash pop") == "bare-stash"


def test_stash_pop_with_an_explicit_ref_is_clean():
    assert footgun("git stash pop 'stash@{2}'") is None


def test_git_stash_push_is_clean():
    assert footgun("git stash push -m wip") is None


# --- 3. pgrep -f matching the shell that runs it ----------------------------------------


def test_a_pgrep_dash_f_waiter_loop_is_denied():
    assert rule("until ! pgrep -f b2_wipe_prefixes; do sleep 15; done") == ("pgrep-self-match")


def test_a_bundled_pgrep_flag_is_denied():
    assert rule("pgrep -cf b2_wipe_prefixes") == "pgrep-self-match"


def test_a_character_class_pattern_is_clean():
    assert footgun("pgrep -f 'b2_[w]ipe_prefixes'") is None


def test_pgrep_without_dash_f_is_clean():
    assert footgun("pgrep sshd") is None


def test_the_word_pgrep_as_a_grep_argument_is_clean(ugrep):
    assert footgun("grep -rn pgrep .claude/hooks") is None


# --- 4. a partial security_and_analysis PATCH -------------------------------------------


def test_a_partial_security_and_analysis_patch_is_denied():
    cmd = "gh api -X PATCH repos/o/r -f security_and_analysis[secret_scanning][status]=enabled"
    assert "dependabot_security_updates" in footgun(cmd).reason


def test_a_patch_naming_all_five_members_is_clean():
    fields = " ".join(
        f"-f security_and_analysis[{m}][status]=enabled"
        for m in footguns._SECURITY_ANALYSIS_MEMBERS
    )
    assert footgun(f"gh api -X PATCH repos/o/r {fields}") is None


def test_a_read_of_security_and_analysis_is_clean():
    assert footgun("gh api repos/o/r --jq .security_and_analysis") is None


# --- unreadable text, and the merge into pre_tool_use -----------------------------------


def test_an_unreadable_command_is_no_decision():
    """The module docstring's DECIDED: no ask, unlike the server's copy."""
    assert footgun("git stash pop 'oops") is None


def test_a_heredoc_body_with_an_odd_quote_is_no_decision():
    """dotfiles #614's vector must not come back as a footgun prompt."""
    cmd = 'gh pr create --title t --body "$(cat <<\'EOF\'\nA 5" screen.\nEOF\n)"'
    assert footgun(cmd) is None


def test_a_footgun_deny_reaches_the_pre_tool_use_json():
    payload = json.dumps({"tool_input": {"command": "git stash pop"}})
    out = json.loads(pre_tool_use(payload, {"HOME": "/nonexistent-home"}))
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "stash@" in out["hookSpecificOutput"]["permissionDecisionReason"]


def test_merge_keeps_the_stronger_verdict():
    upgrade = Verdict("allow", "force-push-upgrade", "", updated_command="x")
    slip = Verdict("deny", "bare-stash", "pop by ref")
    danger = Verdict("deny", "rm-root", "no")
    assert merge(NONE, None) is NONE
    assert merge(NONE, slip) is slip
    assert merge(upgrade, slip) is slip
    assert merge(danger, slip) is danger
