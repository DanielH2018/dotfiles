"""Ports the cases of tests/hooks/cmdparse.test.js, with the same names in snake_case.

The shared corpus lives in tests/test_vectors.py (Task 5). `visible()` is the view
every consumer takes: stripped, empties dropped.
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


def test_a_combined_redirect_is_not_a_separator():
    # `&>` and `&>>` send both streams to a file. Reading the `&` as a separator
    # turned `cmd &>/dev/null` into a background job plus a bare `>/dev/null`
    # (DanielH2018/server#2198).
    for cmd in ("cmd &>/dev/null", "cmd &>>log", "make &> build.log"):
        p = parse(cmd)
        assert visible(p) == [cmd], cmd
        assert seps(p) == ["eof"], cmd


def test_a_lone_ampersand_before_a_word_still_separates():
    p = parse("cmd & >out")
    assert visible(p) == ["cmd", ">out"]
    assert seps(p) == ["&", "eof"]


def test_a_trailing_separator_does_not_create_an_empty_second_command():
    for cmd, sep in (
        ("ls;", ";"),
        ("ls\n", "newline"),
        ("ls &&\n", "&&"),
        ("ls &", "&"),
    ):
        p = parse(cmd)
        assert len(p.segments) == 1, cmd
        # The collapse drops the empty segment the trailing separator opened; it does NOT
        # drop the separator. `ls &` reporting sep `eof` erased the backgrounding, which an
        # allow-side reader decides on (DanielH2018/server#2261).
        assert p.segments[0].sep == sep, cmd


def test_a_command_with_no_trailing_separator_still_reports_eof():
    # The control for the case above: nothing is collapsed, so the sep stays `eof`.
    assert parse("ls").segments[0].sep == "eof"


def test_a_trailing_command_after_a_separator_is_not_collapsed():
    p = parse("ls; pwd")
    assert len(p.segments) == 2


# --- quotes and escapes ----------------------------------------------------------------


def test_a_quoted_separator_does_not_split():
    assert visible(parse("echo 'a; b' && echo \"c | d\"")) == ["echo 'a; b'", 'echo "c | d"']


def test_separately_quoted_arguments_still_split_between_them():
    assert visible(parse("echo 'a'; echo 'b'")) == ["echo 'a'", "echo 'b'"]


def test_an_escaped_separator_does_not_split():
    assert visible(parse("echo a\\; b")) == ["echo a\\; b"]


def test_a_single_quote_inside_double_quotes_is_inert():
    p = parse('echo "it\'s"; ls')
    assert p.ok
    assert visible(p) == ['echo "it\'s"', "ls"]


def test_an_unbalanced_quote_is_refused_never_approximated():
    p = parse("echo 'oops; rm -rf /")
    assert p.status == "unreadable:unbalanced-quote"
    assert p.segments == ()
    assert not p.ok


def test_an_unbalanced_double_quote_is_refused():
    assert parse('echo "oops').status == "unreadable:unbalanced-quote"


# --- substitutions ---------------------------------------------------------------------


def test_command_and_process_substitution_parse_instead_of_refusing_and_expose_their_content():
    p = parse("echo $(ls; terraform apply) <(cat x)")
    assert p.ok
    assert len(p.segments) == 1
    assert p.substitutions == ("ls", " terraform apply", "cat x")


def test_a_substitution_inside_double_quotes_is_not_a_blind_spot():
    p = parse('echo "$(id)"')
    assert p.ok
    assert p.substitutions == ("id",)


def test_a_backtick_substitution_is_recorded():
    p = parse("echo `whoami`; ls")
    assert visible(p) == ["echo `whoami`", "ls"]
    assert p.substitutions == ("whoami",)


def test_nested_substitutions_are_each_recorded_exactly_once():
    p = parse("echo $(echo $(id))")
    assert p.ok
    assert p.substitutions == ("id", "echo $(id)")


def test_a_substitution_containing_a_quote_parses_and_its_content_is_exposed_intact():
    p = parse('echo "$(echo "inner"; ls)"')
    assert p.ok
    assert p.substitutions == ('echo "inner"', " ls")


def test_dollar_brace_is_not_treated_as_execution():
    p = parse("echo ${x:-default}; ls")
    assert p.ok
    assert p.substitutions == ()
    assert visible(p) == ["echo ${x:-default}", "ls"]


def test_a_substitution_nested_inside_dollar_brace_is_still_found():
    p = parse("echo ${x:-$(id)}")
    assert p.substitutions == ("id",)


def test_arithmetic_is_tracked_but_records_no_substitution():
    p = parse("echo $((1 << 2)); ls")
    assert p.ok
    assert p.substitutions == ()
    assert visible(p) == ["echo $((1 << 2))", "ls"]


def test_an_unbalanced_substitution_is_still_refused():
    p = parse("echo $(ls")
    assert p.status == "unreadable:substitution"


def test_an_unbalanced_quote_inside_a_substitution_reports_the_quote():
    assert parse("echo $(echo 'x)").status == "unreadable:unbalanced-quote"


# --- heredocs --------------------------------------------------------------------------

BODY = "line one; rm -rf /\nline two && terraform destroy\n"


def test_a_heredoc_body_is_lifted_not_segmented():
    p = parse(f"cat <<'EOF'\n{BODY}EOF")
    assert p.ok
    assert visible(p) == ["cat <<'EOF'"]
    assert p.segments[0].heredocs == (BODY,)
    assert p.segments[0].heredoc_quoted == (True,)


def test_an_unquoted_delimiter_is_recorded_as_unquoted():
    p = parse(f"cat <<EOF\n{BODY}EOF")
    assert p.segments[0].heredocs == (BODY,)
    assert p.segments[0].heredoc_quoted == (False,)


def test_two_heredocs_on_one_command_keep_their_quoted_flags_aligned():
    p = parse("cat <<A <<'B'\n1\nA\n2\nB")
    assert p.segments[0].heredocs == ("1\n", "2\n")
    assert p.segments[0].heredoc_quoted == (False, True)


def test_a_redirect_alongside_a_heredoc_stays_visible_in_the_segment():
    p = parse("cat > /tmp/x <<'EOF'\nhello\nEOF")
    assert visible(p) == ["cat > /tmp/x <<'EOF'"]
    assert p.segments[0].heredocs == ("hello\n",)


def test_a_command_after_a_terminated_heredoc_is_its_own_segment():
    p = parse("cat <<'EOF'\nhello\nEOF\nls")
    assert visible(p) == ["cat <<'EOF'", "ls"]
    assert p.segments[0].heredocs == ("hello\n",)
    assert p.segments[1].heredocs == ()


def test_dash_strips_leading_tabs_when_matching_the_terminator():
    p = parse("cat <<-EOF\n\thello\n\tEOF\nls")
    assert visible(p) == ["cat <<-EOF", "ls"]
    assert p.segments[0].heredocs == ("\thello\n",)


def test_triple_angle_is_a_herestring_not_a_heredoc():
    p = parse("cat <<< 'hello'; ls")
    assert visible(p) == ["cat <<< 'hello'", "ls"]
    assert p.segments[0].heredocs == ()


def test_a_heredoc_with_no_terminator_runs_to_the_end_of_input():
    p = parse("cat <<'EOF'\nhello\nworld")
    assert p.ok
    assert p.segments[0].heredocs == ("hello\nworld\n",)


def test_a_heredoc_inside_a_double_quoted_substitution_is_lifted_not_misread_as_syntax():
    cmd = "git commit -am \"$(cat <<'EOF'\nbody; with & shell | syntax\nEOF\n)\""
    p = parse(cmd)
    assert p.ok
    assert len(p.segments) == 1
    assert "cat <<'EOF'" in p.substitutions[0]


def test_two_heredocs_on_one_command_are_both_attached_in_order():
    p = parse("diff <(cat <<'A'\none\nA\n) - <<'B'\ntwo\nB")
    assert p.ok
    assert p.segments[0].heredocs == ("one\n", "two\n")
    assert p.substitutions == ("cat <<'A'", "")


def test_an_unterminated_quoted_delimiter_is_refused():
    assert parse("cat <<'EOF\nhello").status == "unreadable:unbalanced-quote"


def test_a_trailing_segment_that_only_carries_a_heredoc_is_not_collapsed():
    # The collapse drops an EMPTY tail; a tail that owns a heredoc body is not empty.
    p = parse("ls;\ncat <<'EOF'\nx\nEOF")
    assert [seg.heredocs for seg in p.segments][-1] == ("x\n",)
