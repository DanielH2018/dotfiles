import json

import pytest

from claude_guard.event import BashInput, parse


def bash_call(**fields) -> str:
    return json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}, **fields})


def test_parse_reads_the_top_level_fields():
    event = parse(
        bash_call(
            cwd="/home/testuser/proj",
            agent_id="a4133",
            agent_type="deep-review",
            permission_mode="default",
            transcript_path="/t/s.jsonl",
            tool_use_id="toolu_1",
        )
    )
    assert event is not None
    assert (event.tool_name, event.cwd, event.agent_id, event.agent_type) == (
        "Bash",
        "/home/testuser/proj",
        "a4133",
        "deep-review",
    )
    assert (event.permission_mode, event.transcript_path, event.tool_use_id) == (
        "default",
        "/t/s.jsonl",
        "toolu_1",
    )


@pytest.mark.parametrize("cwd", [None, "", 5, ["/x"]])
def test_a_missing_empty_or_non_string_cwd_is_none(cwd):
    fields = {} if cwd is None else {"cwd": cwd}
    event = parse(bash_call(**fields))
    assert event is not None and event.cwd is None


@pytest.mark.parametrize("text", ["", "{ not json", "[1, 2, 3]", '"str"', "[" * 100_000])
def test_text_that_is_not_a_json_object_is_no_event(text):
    assert parse(text) is None


def test_the_bash_input_reads_its_flags_strictly():
    event = parse(
        json.dumps(
            {
                "tool_input": {
                    "command": "ls",
                    "run_in_background": 1,
                    "timeout": "600000",
                    "dangerouslyDisableSandbox": "true",
                }
            }
        )
    )
    assert event is not None
    assert event.bash == BashInput("ls", True, None, False)


def test_an_input_without_a_string_command_has_no_bash_input():
    for tool_input in [{}, {"command": 5}, "ls"]:
        event = parse(json.dumps({"tool_name": "Bash", "tool_input": tool_input}))
        assert event is not None and event.bash is None and not event.is_bash


def test_a_command_is_read_whatever_the_tool_name_but_is_bash_needs_bash():
    event = parse(json.dumps({"tool_input": {"command": "rm -rf /"}}))
    assert event is not None
    assert event.bash is not None and event.bash.command == "rm -rf /"
    assert not event.is_bash
