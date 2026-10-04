import pytest

from cc_wait.source import Description, SourceError, description_from_json, validate


def test_a_source_with_a_failure_state_is_accepted():
    desc = Description(terminal={"done": 0, "failed": 1})
    assert validate(desc) is desc


def test_a_source_that_can_only_succeed_is_refused():
    with pytest.raises(SourceError, match="no failure state"):
        validate(Description(terminal={"done": 0}))


@pytest.mark.parametrize("code", [2, 75])
def test_a_source_declaring_a_reserved_code_is_refused(code):
    with pytest.raises(SourceError, match="reserved exit code"):
        validate(Description(terminal={"done": 0, "gave-up": code}))


def test_a_source_with_no_terminal_state_is_refused():
    with pytest.raises(SourceError, match="no terminal state"):
        validate(Description(terminal={}))


def test_describe_json_without_a_terminal_object_is_refused():
    with pytest.raises(SourceError, match="no `terminal` object"):
        description_from_json('{"watch": []}')
