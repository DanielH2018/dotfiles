"""inert_shell: the listed readers and printers pass, and each way out of the list refuses."""

import pytest

from claude_guard.inert_shell import only_reads_or_prints, printed

READS_OR_PRINTS = [
    "grep -n 'git push --force' README.md",
    'grep -rn "git push origin main$" docs/*.md',
    'grep -n "a\\$b \\"git push\\" \\d" f',
    "grep -n git\\ push\\ --force f",
    "grep -n 'git push --force' README.md | head -5 | wc -l",
    "grep -q 'git push -f' a.md && echo 'found git push -f' || echo missing >&2",
    "grep -n 'a' f 2> /dev/null >/dev/null",
    "printf '%s\\n' 'git push --force'",
    "printf -- '-%s\\n' x",
    "rg -n -e 'git push --force' -g '*.md' docs",
    "rg -ine 'git push --force' --glob='*.md' -- *.md",
    "rg --hidden --type md -C3 'git push --force'",
]
NOT_PROVEN = [
    # a command off the list, or one whose name is not the bare word
    "sort 'git push --force'",
    "./grep 'git push --force' f",
    "X=1 grep 'git push --force' f",
    "env grep 'git push --force' f",
    "gr* 'git push --force' f",
    # one segment off the list is enough
    "grep 'git push --force' f; make",
    # an rg option that runs a program, or one the list does not name
    "rg --pre cat 'git push --force'",
    "rg -nz 'git push --force'",
    "rg --hidden=--pre=cat 'git push --force'",
    "rg -e -- --pre=cat 'git push --force'",
    "rg 'git push --force' *",
    "rg -e * 'git push --force'",
    "printf -v PATH '%s' /tmp/e",
    "printf [-]v PATH /tmp/e",
    # a redirect that is not a whole unquoted /dev/null or fd word
    "echo 'git push --force' > x.sh",
    "echo 'git push --force' >'x.sh'",
    "echo 'git push --force' >/dev/null'x'",
    "echo x &>/dev/null",
    "grep 'git push --force' < f",
    "cat <<'EOF'\ngit push --force\nEOF",
    # expansion, substitution, grouping, backgrounding
    'grep "$P" f',
    "echo $'git push --force'",
    'grep "$(git push --force)" f',
    "(grep 'git push --force' f)",
    "{ grep 'git push --force' f; }",
    "grep 'git push --force' f &",
    # text the reader cannot follow
    "grep 'git push --force f",
    "grep 'git push --force' f # note",
    "grep 'git push --force' f \\",
    "grep 'git push --force' f\r",
]


@pytest.mark.parametrize("command", READS_OR_PRINTS)
def test_a_command_of_listed_readers_and_printers_is_proven(command):
    assert only_reads_or_prints(command)


@pytest.mark.parametrize("command", NOT_PROVEN)
def test_anything_outside_the_list_is_not_proven(command):
    assert not only_reads_or_prints(command)


PRINTED = [
    ("echo 'print(1)'", "print(1)"),
    ('echo -n "a = 1" b', "a = 1 b"),
    ("echo 'x' 2>/dev/null", "x"),
    ("printf '%s\\n' 'a = 1' 'print(a)'", "a = 1\nprint(a)\n"),
    ("printf '%s' 'a\\n'", "a\\n"),
    ("printf 'a = 1\\nprint(a)\\n'", "a = 1\nprint(a)\n"),
]
NOT_READ = [
    # another command, and a printer the words do not start with
    "cat f",
    "env echo 'print(1)'",
    "echo 'print(1)' )",
    "echo 'print(1)' > f",
    # a word the shell or the printer may rewrite
    'echo "print($x)"',
    "echo *.py",
    "echo 'a\\nb'",
    "printf 'a\\tb'",
    "printf 'a%db' 1",
    "printf '%s %s' a b",
    "printf -v x 'print(1)'",
    "printf 'print(1)' extra",
]


@pytest.mark.parametrize(("command", "text"), PRINTED)
def test_the_text_an_echo_or_a_printf_writes_is_read_from_its_words(command, text):
    assert printed(command) == text


@pytest.mark.parametrize("command", NOT_READ)
def test_a_segment_whose_output_the_words_do_not_give_prints_nothing_readable(command):
    assert printed(command) is None
