"""A read-only agent's Bash writes are denied by the PreToolUse hook (dotfiles #848).

Driven through `hook.pre_tool_use` with a temp HOME whose `.claude/agents/` holds one
read-only agent and one that writes, as the harness sends a subagent's payload.
"""

import json
from pathlib import Path

import pytest

from claude_guard.hook import pre_tool_use

AGENTS_SOURCE = Path(__file__).resolve().parents[4] / "private_dot_claude" / "agents"
READ_ONLY_AGENTS = ("deep-review", "root-cause", "migration-reviewer")


@pytest.fixture
def env(tmp_path):
    home = tmp_path / "home"
    agents = home / ".claude" / "agents"
    agents.mkdir(parents=True)
    for name in READ_ONLY_AGENTS:
        (agents / f"{name}.md").write_text(
            f"---\nname: {name}\ntools: Read, Bash\nread_only: true\n---\nbody\n"
        )
    (agents / "implementer.md").write_text("---\nname: implementer\ntools: '*'\n---\nbody\n")
    return {"HOME": str(home), "PATH": "/usr/bin:/bin"}


def decision(command: str, env: dict, agent: str | None) -> str:
    payload: dict = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "/repo"}
    if agent:
        payload["agent_type"] = agent
    out = pre_tool_use(json.dumps(payload), env)
    if out is None:
        return "none"
    return json.loads(out)["hookSpecificOutput"].get("permissionDecision", "none")


def reason(command: str, env: dict, agent: str) -> str:
    payload = {"tool_name": "Bash", "tool_input": {"command": command}, "agent_type": agent}
    return json.loads(pre_tool_use(json.dumps(payload), env))["hookSpecificOutput"][
        "permissionDecisionReason"
    ]


REDIRECTS_INTO_THE_TREE = [
    "echo x > src/app.py",
    "printf 'x' >> /repo/notes.md",
    "cat <<'EOF' > fix.patch\nx\nEOF",
    "grep -n x a.py &> out.txt",
]
CHANGES_FILES = [
    "rm -rf src",
    "sed -i 's/a/b/' src/app.py",
    "mv a.py b.py",
    "touch /repo/new.py",
    "cp /tmp/x.py src/x.py",
    "find . -name '*.pyc' -delete",
    "timeout 5 rm src/app.py",
    "git ls-files | xargs rm",
    "bash -c 'echo hi'",
    "ls $(rm -f src/app.py)",
]
MUTATING_GIT_AND_GH = [
    "git commit -m wip",
    "git push origin HEAD",
    "git -C /repo checkout -- .",
    "git branch -D main",
    "git stash",
    "git -c core.pager=sh log",
    "gh pr comment 5 --body hi",
    "gh pr merge 5",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
]
READS = [
    "git status --short && git diff HEAD~1 -- src",
    "git log --oneline -5 | head -3",
    "git branch --list",
    "gh pr view 5 --json body",
    "gh pr diff 5",
    "gh api repos/o/r/pulls/5",
    "grep -rn foo src 2>/dev/null",
    "uv run pytest tests/test_x.py -q > /tmp/run.txt 2>&1",
    "mkdir -p /tmp/rc && cp src/app.py /tmp/rc/",
    "rm -f /tmp/rc/out.txt",
    "sed -n 1,20p src/app.py",
]


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", REDIRECTS_INTO_THE_TREE)
def test_a_redirect_into_the_tree_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", CHANGES_FILES)
def test_a_command_that_changes_files_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", MUTATING_GIT_AND_GH)
def test_a_mutating_git_or_gh_verb_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("command", READS)
def test_a_read_and_a_scratch_write_are_not_denied(env, command):
    assert decision(command, env, "root-cause") != "deny"


def test_the_main_session_and_a_writing_agent_are_not_judged(env):
    for agent in (None, "implementer"):
        assert decision("git commit -m wip", env, agent) != "deny"
        assert decision("echo x > src/app.py", env, agent) != "deny"


def test_the_denial_names_the_agent_and_what_wrote(env):
    text = reason("git push origin HEAD", env, "deep-review")
    assert "`deep-review` is read-only" in text
    assert "`git push`" in text


def test_the_three_read_only_agents_declare_it_in_their_frontmatter():
    for name in READ_ONLY_AGENTS:
        frontmatter = (AGENTS_SOURCE / f"{name}.md").read_text().split("\n---", 1)[0]
        assert "\nread_only: true" in frontmatter, name
