"""claude_guard.apply_guard's flattened-text fallback, for a command the parser cannot read.

The guard's behaviour through the shims, with a stub chezmoi, is pinned in the dotfiles
repo's tests/chezmoi/chezmoi-apply-guard.test.js. A shim can reach this fallback only with an
unreadable command, so its cases are pinned here directly.
"""

import pytest

from claude_guard.apply_guard import decide, text_decision

ODD_QUOTE_BODY = (
    'gh pr create --title "Stop the chezmoi apply guard misfiring" --body "$(cat <<\'EOF\'\n'
    'A 5" screen shows it.\nEOF\n)"'
)


@pytest.mark.parametrize(
    "command",
    [
        'git commit -m "fix chezmoi apply guard"',
        'GH_REPO=a/b uv run python findings.py open --title "Stop refusing chezmoi apply"',
        "git commit -F - <<'EOF'\nFix guard\n\nIt no longer refuses chezmoi apply.\nEOF",
        ODD_QUOTE_BODY,
        "chezmoi apply -n",
        "CHEZMOI_APPLY_GUARD=off chezmoi apply",
    ],
)
def test_text_that_cannot_run_an_apply_is_not_one(command):
    assert not text_decision(command).writes


@pytest.mark.parametrize(
    "command", ['echo "$(chezmoi apply)"', "chezmoi apply", "chezmoi \\\n apply"]
)
def test_an_apply_outside_quotes_or_inside_a_substitution_writes(command):
    assert text_decision(command).writes


def test_the_fallback_never_takes_the_stale_source_refusal():
    d = text_decision("chezmoi apply ~/.zshrc")
    assert (d.writes, d.reads_primary, d.targets) == (True, False, ["~/.zshrc"])


def test_an_unreadable_chezmoi_command_falls_back_rather_than_passing():
    assert decide('chezmoi apply "unbalanced').writes
