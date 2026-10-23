"""A read-only agent's Bash writes are denied by the PreToolUse hook (dotfiles #848).

Driven through `hook.pre_tool_use` with a temp HOME whose `.claude/agents/` holds one
read-only agent and one that writes, as the harness sends a subagent's payload.
"""

import json
import sys
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
    "git log --outp=src/app.py",
    "git branch --set-up=origin/x",
    "GIT_EXTERNAL_DIFF=/tmp/x.sh git diff",
    "gh pr comment 5 --body hi",
    "gh pr merge 5",
    "gh api -X POST repos/o/r/issues",
    "gh api repos/o/r/issues -f title=x",
    "git remote -v add other https://example.invalid/r",
    "git remote --verbose set-url origin https://example.invalid/r",
]
# A write inside a compound command, behind a runner the wrapper table does not list, or
# through a link that carries a later scratch write into the tree.
HIDDEN_WRITES = [
    "for f in a; do git push; done",
    "until false; do git push; done",
    "if true; then rm -rf src; fi",
    "case x in x) rm -rf src;; esac",
    "select x in a; do rm -rf src; done",
    "f(){ git push; }; f",
    "f() { rm -rf src; }; f",
    "function f { git push; }; f",
    "uv run git push",
    "uv run rm -rf src",
    "ionice git push",
    "flock /tmp/l git push",
    "flock /tmp/l -c 'git push'",
    "watch -n1 rm src/a",
    "watch -n1 'rm src/a'",
    "chronic rm src/a",
    "parallel rm ::: src/a",
    "script -c 'rm src/a' /dev/null",
    "busybox rm src/a",
    "env -S 'rm -rf src'",
    "curl -sSLo src/app.py https://example.invalid/x",
    "curl -sX POST https://example.invalid/x",
    "cp -l /repo/src/app.py /tmp/h",
    "cp -s /repo/src/app.py /tmp/l",
    "cp --link /repo/src/app.py /tmp/h",
    "cp --symbolic-link /repo/src/app.py /tmp/l",
    "rsync -a --link-dest=/repo/src /repo/src/ /tmp/rc/",
]
# A runner no table names, so these rows hold for the class rather than for a list: the
# command it runs is a later word, or a string whose first word is not the write.
UNKNOWN_RUNNERS = [
    "frobnicate rm src/a",
    "frobnicate -x git push",
    "frobnicate -c 'true; git push'",
    "frobnicate 'echo x > src/a'",
    "watch 'cd src && rm a'",
    "watch 'true; rm src/a'",
    "watch 'echo x > src/a'",
    "flock /tmp/l -c 'timeout 5 rm src/a'",
    "flock /tmp/l -c 'FOO=1 git push'",
    "busybox ash -c 'cd s; rm a'",
    "frobnicate 'true; rm src/a; <(('",
    # An operand named like a code runner does not end the scan.
    "flock /tmp/python git push",
    "frobnicate node rm src/a",
    "flock /tmp/psql -c 'true; rm src/a'",
    "GIT_EXTERNAL_DIFF=/tmp/x.sh uv run git diff",
    "env GIT_EXTERNAL_DIFF=/tmp/x.sh uv run git diff",
]
# dotfiles #958: a change to a cluster, a container or another machine. The later rows are
# the shapes two earlier attempts let through: a container path that looks like scratch, a
# fused `--entrypoint=`, a value flag the table did not list, a quoted `'>'` the remote
# shell reads as a redirect, and a runner whose own argument is named `pytest`.
WRITES_ELSEWHERE = [
    "kubectl apply -f deploy.yaml",
    "kubectl delete pod web-1",
    "kubectl rollout restart deploy/web",
    "kubectl config use-context prod",
    "kubectl cp web:/x /tmp/x",
    "kubectl exec web -- rm /tmp/x",
    "kubectl --foo apply get pods",
    "kubectl cluster-info dump --output-directory /tmp/d",
    "docker rm web",
    "docker pull nginx",
    "docker run -d --name x nginx",
    "docker run --expose 80 -d nginx",
    "docker run -v /repo:/tmp/w alpine rm -rf /tmp/w/src",
    "docker run --mount type=bind,src=/repo,dst=/w,readonly=false img",
    "docker run --entrypoint=rm -v /repo:/w alpine -rf /w/src",
    "docker compose run --entrypoint=rm web /app/x",
    "docker exec c touch /tmp/x",
    "docker container exec c rm /tmp/x",
    "docker --config /tmp/c ps",
    "ssh host rm -rf /srv/x",
    "ssh host",
    "ssh host 'cat x' '>' /etc/y",
    "ssh host 'ls; rm x'",
    "ssh host '/bin/r? -rf x'",
    "ssh host docker run -d nginx",
    "ssh host 'kubectl delete pod x'",
    "ssh -o ProxyCommand=sh host ls",
    "ssh host <<'EOF'\nrm -rf x\nEOF",
    "hl rm -rf /srv/x",
    "hl 'cat x' '>' y",
    "timeout 5 kubectl delete pod x",
    "uv run kubectl apply -f x",
    "KUBECONFIG=/tmp/k kubectl delete pod x",
    "frobnicate pytest kubectl delete pod x",
    "watch 'kubectl delete pod x'",
    "env ssh host rm x",
    "/bin/r? -rf src",
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
    "for f in a.py b.py; do git log -1 --oneline -- $f; done",
    "if git diff --quiet; then echo same; fi",
    "uv run git status",
    "curl -sSL https://example.invalid/x",
    "cp -r src /tmp/rc/",
    "git remote -v",
    "grep -rn 'git push' src",
    # Behind a runner: a `.` operand is a directory, and code in another language
    # (Python, SQL) is not shell text to judge.
    "uv run ruff check .",
    "uv run pytest -k 'a and not b' tests/",
    "uv run python -c 'print(1 > 0)'",
    "python3 -c 'import sys; print(sys.version_info >= (3, 11))'",
    "psql -c 'select 1 where 2 > 1'",
    "ssh host 'journalctl -u x | grep y'",
    "timeout 60 uv run pytest -q",
    # An assignment a runner holds is checked only when it names a variable git reads, and
    # a quoted argument is shell text only when it opens with a command this module knows.
    "PYTHONPATH=. uv run pytest -k git",
    "PYTHONPATH=. uv run git log -1",
    "frobnicate -e FOO=1 img git log",
    "pytest -k 'not ln' tests/",
    "uv run pytest -k 'not ln' tests/",
    "uv run pytest -k '(cp or mv) and not slow'",
    "ug -n 'echo x > y' src",
    "xmllint --xpath '//a[@b > 1]' f.xml",
    "pip index versions 'requests >= 2'",
    # A read of a cluster, a container or another machine.
    "kubectl get pods -n web",
    "kubectl -n web logs deploy/x --tail 50",
    "kubectl --context=prod describe pod x",
    "kubectl config view",
    "kubectl rollout status deploy/web",
    "docker ps -a",
    "docker logs --tail 50 web",
    "docker exec web cat /etc/hostname",
    "ssh daniel-server uptime",
    "ssh -o BatchMode=yes host 'journalctl -u x | grep y'",
    "hl kubectl get pods",
    "watch 'kubectl get pods'",
    # The test builtins are not glob command words, and a directory named `docker` is data.
    "[ -f src/app.py ] && echo y",
    "if [[ -n x ]]; then echo y; fi",
    "cd docker && ls",
    "du -sh docker",
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


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", HIDDEN_WRITES)
def test_a_write_inside_a_compound_or_behind_a_runner_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", UNKNOWN_RUNNERS)
def test_a_write_behind_a_runner_no_table_names_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("agent", READ_ONLY_AGENTS)
@pytest.mark.parametrize("command", WRITES_ELSEWHERE)
def test_a_change_to_a_cluster_container_or_remote_host_is_denied(env, agent, command):
    assert decision(command, env, agent) == "deny"


@pytest.mark.parametrize("command", READS)
def test_a_read_and_a_scratch_write_are_not_denied(env, command):
    if sys.platform == "win32" and "/tmp" in command:
        pytest.skip(
            "Git Bash's /tmp is %TEMP%, which Python's realpath cannot see; "
            "the scratch arm fails closed on Windows"
        )
    assert decision(command, env, "root-cause") != "deny"


def test_the_main_session_and_a_writing_agent_are_not_judged(env):
    for agent in (None, "implementer"):
        assert decision("git commit -m wip", env, agent) != "deny"
        assert decision("echo x > src/app.py", env, agent) != "deny"


def test_the_denial_names_the_agent_and_what_wrote(env):
    text = reason("git push origin HEAD", env, "deep-review")
    assert "`deep-review` is read-only" in text
    assert "`git push`" in text


def test_a_command_name_held_in_a_variable_is_a_write_in_the_arm_itself():
    # The deny rules already refuse a variable command word for every session, so the hook
    # cannot show this; the arm must not rely on that rule staying where it is.
    from claude_guard.checks.read_only_agents import problem

    for command in ["G=git; $G push", "X=rm; $X -rf src", '"$G" log']:
        assert problem(command, ("/tmp",)) is not None, command


def test_a_string_the_segmenter_cannot_read_is_denied_for_the_command_it_names():
    from claude_guard.checks.read_only_agents import problem

    found = problem("frobnicate 'true; rm src/a; <(('", ("/tmp",))
    assert found == "passes a command string this hook cannot read"
    assert problem("frobnicate 'a.b; <(('", ("/tmp",)) is None


def test_the_three_read_only_agents_declare_it_in_their_frontmatter():
    for name in READ_ONLY_AGENTS:
        frontmatter = (AGENTS_SOURCE / f"{name}.md").read_text().split("\n---", 1)[0]
        assert "\nread_only: true" in frontmatter, name
