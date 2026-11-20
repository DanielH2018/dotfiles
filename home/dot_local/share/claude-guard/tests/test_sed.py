import pytest

from claude_guard.checks.sed import EXEC, LAST_LINE, UNREAD, WRITE, effects, sed_risk

RUNS_A_COMMAND = [
    "e id",
    "1e id",
    "$!N;1e id",
    "/x/{e id\n}",
    "s/x/id/e",
    "s/x/id/gew out",
    "s/[/]/x/e",
    "1!e",
]

RUNS_NOTHING = [
    "s/one/two/g",
    "/begin/,/end/p",
    "1,5p",
    "2q",
    f"{LAST_LINE}d",
    "1i # a header line",
    f"{LAST_LINE}a export EDITOR=vi",
    "/x/c\\\nreplaced here",
    "/x/b end\ns/a/b/\n:end",
    "y/abc/xyz/",
    "s|/home/x|/home/e|",
    "s/[^/]*e$//",
    "0~3d",
    "/re/I,+2!{p;d}",
    "# e is only a comment",
    "${n}p",
]


@pytest.mark.parametrize("script", RUNS_A_COMMAND)
def test_a_script_that_runs_a_command_is_found(script):
    assert EXEC in effects(script)


@pytest.mark.parametrize("script", RUNS_NOTHING)
def test_an_e_inside_text_a_label_or_a_pattern_runs_nothing(script):
    assert effects(script) == frozenset()


def test_a_file_the_script_writes_is_reported_apart_from_a_command():
    assert effects("/x/w out.txt") == {WRITE}


@pytest.mark.parametrize("script", ["s/unterminated", "k", "1,"])
def test_a_script_that_does_not_parse_has_no_reading(script):
    assert effects(script) is None


@pytest.mark.parametrize(
    ("command", "risk"),
    [
        ("sed -n '1e id' f", EXEC),
        ("sed -n -e p -e '1e id' f", EXEC),
        ("sed --exp='1e id' f", EXEC),
        ("printf 'a\\n' | xargs sed -n '1e id'", EXEC),
        ("ssh host \"sed -n '1e id' f\"", EXEC),
        ('sed -n "$(wc -l < f)e id" f', EXEC),
        ("sed -f edit.sed f", UNREAD),
        ("sed --s -n p f", UNREAD),
        ('sed "$script" f', UNREAD),
        ("sed --sandbox -n '1e id' f", None),
        ("sed '$a text here' f", None),
        ("sed -i.bak -e 's/a/b/' f", None),
        ('sed -n "$(grep -n x f | cut -d: -f1),+5p" f', None),
        ("sed -n 5,9p <(ghread pr view 1)", None),
        ("grep -n sed notes.md", None),
        ("git commit -m \"explain sed -n '1e id'\"", None),
    ],
)
def test_a_sed_is_read_wherever_the_command_runs_it(command, risk):
    assert sed_risk(command) == risk
