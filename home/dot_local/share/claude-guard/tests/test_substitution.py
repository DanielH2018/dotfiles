import pytest

from claude_guard.substitution import PLACEHOLDER, Masked, mask


def test_mask_cuts_out_each_top_level_substitution():
    assert mask('echo "a $(git log -1 | head -1)" <(ls)') == Masked(
        f'echo "a {PLACEHOLDER}" {PLACEHOLDER}', ("git log -1 | head -1", "ls")
    )
    # The nested one stays inside its parent, for the judge to find when it judges that.
    assert mask("echo $(echo $(ls))") == Masked(f"echo {PLACEHOLDER}", ("echo $(ls)",))
    assert mask("echo '$(ls)' $((1 + 2))") == Masked("echo '$(ls)' $((1 + 2))", ())


@pytest.mark.parametrize(
    "command",
    [
        "echo `ls`",
        f"echo {PLACEHOLDER} $(ls)",
        # A substitution inside arithmetic or ${ } is not top level, so it stays in the
        # masked text and the parse cross-check refuses.
        "echo $(( $(ls) + 1 ))",
        'echo "${x:-$(ls)}"',
        "echo $(ls",
    ],
)
def test_mask_refuses_what_it_cannot_cut_out(command):
    assert mask(command) is None
