"""awk's command-execution forms, closed through the `Bash(awk:*)` allow rule (dotfiles #702).

The settings allow awk everywhere and deny only `system(`. These pairs pin the other ways an
awk program runs a command, on both hook paths: PreToolUse (`pre_tool_use`), which sees a
bare awk before the native allow rule approves it, and the PermissionRequest judge, which
would otherwise auto-approve a prompted awk through the same allow rule.
"""

import json

import pytest
from test_judge import rules_for

from claude_guard.checks.awk import awk_risk
from claude_guard.hook import pre_tool_use
from claude_guard.judge import judge

ENV = {"HOME": "/nonexistent-home"}

# Each runs a command. A deny names the definite forms; the rest prompt.
DENIED = [
    """awk 'BEGIN{print "id" | "sh"}'""",
    """awk 'BEGIN{"id" | getline x; print x}'""",
    """awk 'BEGIN{cmd="id"; cmd | getline x}'""",
    """awk 'BEGIN{print "id" |& "sh"}'""",
    """awk 'BEGIN{system("id")}'""",
    """awk 'BEGIN{system ("id")}'""",
    """gawk 'BEGIN{print "id" | "python3"}'""",
    """ls | /usr/bin/awk '{print | "sh"}'""",
    """timeout 5 awk 'BEGIN{"id" | getline}'""",
    # A quote in a comment, or a division the lexer could take for a regex, hides nothing.
    """awk '# it"s
{print "id" | "sh"}'""",
    """awk '{x++ / 2; print "id" | "sh"; y = 1 / 2}'""",
]
ASKED = [
    # A pipe to a command held in a variable: no quote follows the `|`.
    """awk 'BEGIN{c="sh"; print "id" | c}'""",
    # The program comes from a file the guard cannot read.
    "awk -f prog.awk data.txt",
    "gawk --exec prog.awk",
    """gawk '@load "filefuncs"; BEGIN{}'""",
    # A long option with a separate value must not hide the program behind it.
    """awk --field-separator , 'BEGIN{c="sh"; print "id" | c}'""",
    """gawk --source 'BEGIN{c="sh"; print "id" | c}'""",
    # A program the shell builds from a command substitution.
    'awk "$(cat prog.awk)" f',
    'awk "`cat prog.awk`" f',
]
# Ordinary awk, each still approved by the allow rule.
ALLOWED = [
    "awk '{print $1}'",
    "awk '/filesystem/'",
    "df -h | awk '/filesystem/ {print $5}'",
    "awk -F'|' '{print $2}' table.txt",
    "awk -F '|' '{print $2}' table.txt",
    """awk -v sep='|' '{print $1 sep $2}' f""",
    'awk \'$1 == "a" || $2 == "b"\' f',
    "awk '$3 > 100' f",
    "awk '{print $1}' f | sort | uniq -c",
    # A `|` inside a regex or a string literal is not a pipe.
    "awk '/a|b/' f",
    """awk '{print $1 " | " $2}' f""",
    "awk '$3 ~ /^(cd|ls) (;|&&)/' f",
    # awk's own `$(NF-1)` is a field, and an awk inside a substitution is judged alone.
    "kubectl get nodes | awk '{print $1, $(NF-1)}'",
    """D=$(grep -m1 d f | awk '{print $2}' | tr -d '"'); echo $D""",
    # A backtick inside the single-quoted program is text, not a substitution.
    "awk '/^```/{f=!f} f' README.md",
]


def decision(command: str) -> str:
    out = pre_tool_use(json.dumps({"tool_input": {"command": command}}), ENV)
    return json.loads(out)["hookSpecificOutput"]["permissionDecision"] if out else "none"


@pytest.mark.parametrize("command", DENIED)
def test_an_awk_that_runs_a_command_is_denied(command):
    assert decision(command) == "deny"


@pytest.mark.parametrize("command", ASKED)
def test_an_awk_that_may_run_a_command_prompts(command):
    assert decision(command) == "ask"


@pytest.mark.parametrize("command", ALLOWED)
def test_ordinary_awk_gets_no_decision(command):
    assert decision(command) == "none"


def test_the_deny_reason_names_the_form():
    assert "getline" in awk_risk("""awk 'BEGIN{"id" | getline x}'""")[1]


AWK_ALLOW = {"allow": ["Bash(awk:*)", "Bash(ls:*)", "Bash(df:*)", "Bash(sort:*)"], "deny": []}


@pytest.mark.parametrize("command", DENIED[:5] + ASKED[:1])
def test_the_judge_does_not_auto_approve_an_awk_that_runs_a_command(tmp_path, command):
    rules = rules_for(tmp_path, AWK_ALLOW)
    assert not judge(command, rules, (), "/tmp").allow


@pytest.mark.parametrize("command", ["awk '{print $1}'", "df -h | awk '/filesystem/'"])
def test_the_judge_still_approves_ordinary_awk(tmp_path, command):
    rules = rules_for(tmp_path, AWK_ALLOW)
    assert judge(command, rules, (), "/tmp").allow
