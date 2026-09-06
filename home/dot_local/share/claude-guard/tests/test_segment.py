"""Port of tests/hooks/cmdparse.test.js, case for case, plus the shared corpus.

Every case names the bash test it mirrors so a divergence can be traced to the
original. `visible()` is the view every consumer takes: stripped, empties dropped.
"""

from claude_guard.segment import Parsed, Segment, parse, visible


def seps(p: Parsed) -> list[str]:
    return [s.sep for s in p.segments]


# --- separators ------------------------------------------------------------------------


def test_a_single_command_reports_one_segment_terminated_by_eof():
    p = parse("ls -la")
    assert p.ok
    assert p.segments == (Segment("ls -la", "eof", (), ()),)


def test_a_newline_separates_two_commands():
    p = parse("echo x\nterraform destroy")
    assert visible(p) == ["echo x", "terraform destroy"]
    assert seps(p) == ["newline", "eof"]


def test_the_newline_split_agrees_with_the_semicolon_and_and_and_glued_forms():
    forms = [
        "echo x\nterraform destroy",
        "echo x; terraform destroy",
        "echo x && terraform destroy",
        "echo x&&terraform destroy",
    ]
    assert {tuple(visible(parse(f))) for f in forms} == {("echo x", "terraform destroy")}


def test_a_lone_ampersand_separates_and_does_not_glue_the_tail_onto_the_previous_segment():
    p = parse("git status && ls & rm -rf /")
    assert visible(p) == ["git status", "ls", "rm -rf /"]
    assert seps(p) == ["&&", "&", "eof"]


def test_a_pipe_separates_and_the_separator_is_recorded():
    p = parse("cat f | wc -l")
    assert visible(p) == ["cat f", "wc -l"]
    assert seps(p) == ["|", "eof"]


def test_or_or_is_one_separator_not_two_pipes():
    p = parse("test -f x || echo missing")
    assert visible(p) == ["test -f x", "echo missing"]
    assert seps(p) == ["||", "eof"]


def test_fd_dups_are_not_separators():
    p = parse("cmd 2>&1 >&2")
    assert visible(p) == ["cmd 2>&1 >&2"]


def test_a_trailing_separator_does_not_create_an_empty_second_command():
    for cmd in ("ls;", "ls\n", "ls &&\n"):
        p = parse(cmd)
        assert len(p.segments) == 1, cmd
        assert p.segments[0].sep == "eof", cmd


def test_a_trailing_command_after_a_separator_is_not_collapsed():
    p = parse("ls; pwd")
    assert len(p.segments) == 2
