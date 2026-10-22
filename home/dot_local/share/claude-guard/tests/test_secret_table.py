"""The generated secret blocks in protect-secrets.sh and settings.permissions.json.

Both files live outside this package, in the chezmoi source tree, so these tests skip in a
deployed copy of the package, where neither file sits beside it.
"""

import shutil

import pytest

from claude_guard import secret_table as st

needs_source = pytest.mark.skipif(not st.HOOK.exists(), reason="not in the chezmoi source tree")


@needs_source
def test_the_hook_and_settings_blocks_match_the_table():
    assert st.main(["--check"]) == 0


@needs_source
@pytest.mark.parametrize("target", ["HOOK", "SETTINGS"])
def test_a_block_edited_by_hand_is_reported_as_drift(target, tmp_path, monkeypatch):
    copies = {}
    for name in ("HOOK", "SETTINGS"):
        copies[name] = tmp_path / getattr(st, name).name
        shutil.copy(getattr(st, name), copies[name])
        monkeypatch.setattr(st, name, copies[name])
    text = copies[target].read_text()
    # Drop the first generated line after the BEGIN marker, as a hand edit would.
    begin = st.HOOK_BEGIN if target == "HOOK" else st.SETTINGS_BEGIN
    head, rest = text.split(begin + "\n", 1)
    copies[target].write_text(head + begin + "\n" + rest.split("\n", 1)[1])
    assert st.main(["--check"]) == 1


def test_a_case_pattern_the_shell_would_split_is_refused():
    entry = {"id": "x", "why": "y", "case_arms": ["a b"], "message": "m"}
    with pytest.raises(ValueError, match="needs quoting"):
        st.hook_block([entry])


def test_a_message_the_shell_would_expand_is_refused():
    entry = {"id": "x", "why": "y", "case_arms": ["a"], "message": "Blocked: $HOME"}
    with pytest.raises(ValueError, match="would expand"):
        st.hook_block([entry])
