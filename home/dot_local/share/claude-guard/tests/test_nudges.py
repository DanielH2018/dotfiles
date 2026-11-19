"""The context-discipline nudges (dotfiles #586), the show-substitution nudge, the
whole-file-cat nudge (dotfiles #1076), the whole-file-read nudge on the Read tool (dotfiles
#1085), the gh-rerun-failed and runlog nudges (dotfiles #1223), the ugrep-bounded-class
nudge (dotfiles #1236), and the nudges toward an existing state reader (dotfiles #1391).

Each rule has a command it must nudge and a bounded variant it must leave alone. The
hook-level tests pin that a nudge rides beside a verdict, never on a deny, and only once
per session.
"""

import json
import os
import sys
import threading

import pytest

from claude_guard import nudges
from claude_guard.deny import NONE, Verdict
from claude_guard.event import parse as parse_event
from claude_guard.hook import pre_tool_use_json
from claude_guard.nudges import claim, nudge, tag


@pytest.fixture(autouse=True)
def marker_home(tmp_path, monkeypatch):
    """Keep the once-per-session markers out of the real ~/.cache."""
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    return home


def rule(command: str) -> str | None:
    found = nudge(command)
    return found[0] if found else None


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("git log", "unbounded-log"),
        ("git -C /repo log --stat", "unbounded-log"),
        ("ls -laR /etc", "recursive-ls"),
        ("grep -r retry ~/.claude/projects/", "transcript-grep"),
        ("rg foo session.jsonl | head -20", "transcript-grep"),
        ("python3 -c 'import json,sys; print(json.load(sys.stdin)[\"a\"])'", "python-json"),
        (
            "for f in $(git ls-tree --name-only origin/main w); do git show origin/main:$f; done",
            "show-substitution",
        ),
        ('git show "origin/main:$(git ls-files x | head -1)"', "show-substitution"),
    ],
)
def test_an_unbounded_command_is_nudged(command, expected):
    assert rule(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        "git log -n 20 --oneline",
        "git log --oneline -5",
        "git log origin/main..HEAD",
        "git log --since=2.days",
        "git log | head -30",
        "ls -R src | wc -l",
        "ls -la",
        "grep -r retry ~/.claude/projects/ | cut -c1-200",
        "grep -r retry src/",
        "python3 -c 'print(1 + 1)'",
        "python3 script.py data.json",
        "git show origin/main:README.md",
        "f=README.md; git show origin/main:$f",
    ],
)
def test_a_bounded_command_is_left_alone(command):
    assert rule(command) is None


def test_an_unreadable_command_gets_no_nudge():
    assert nudge("git log 'unterminated") is None


def test_claim_is_won_once_per_transcript_and_rule(tmp_path):
    transcript = str(tmp_path / "t.jsonl")
    assert claim(transcript, "unbounded-log")
    assert not claim(transcript, "unbounded-log")
    assert claim(transcript, "recursive-ls")
    assert claim(str(tmp_path / "other.jsonl"), "unbounded-log")


def test_without_a_transcript_every_call_nudges():
    assert claim("", "unbounded-log")
    assert claim("", "unbounded-log")


def test_a_nudge_alone_is_additional_context_with_no_decision():
    out = json.loads(pre_tool_use_json(NONE, "[claude-guard:nudge:x] bound it"))
    assert out == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "[claude-guard:nudge:x] bound it",
        }
    }


def test_a_nudge_rides_beside_an_allow():
    out = json.loads(pre_tool_use_json(Verdict("allow", "readonly", ""), "n"))
    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert out["hookSpecificOutput"]["additionalContext"] == "n"


def test_a_deny_carries_no_nudge():
    out = json.loads(pre_tool_use_json(Verdict("deny", "r", "no"), "n"))
    assert "additionalContext" not in out["hookSpecificOutput"]


def test_the_hook_nudges_once_per_session(tmp_path):
    from claude_guard.hook import nudge_for

    transcript = tmp_path / "t.jsonl"
    transcript.write_text("{}\n")
    event = parse_event(
        json.dumps({"tool_input": {"command": "git log"}, "transcript_path": str(transcript)})
    )
    first = nudge_for(event)
    assert first and first.startswith(tag("unbounded-log"))
    # A parallel call's hook runs before the harness writes `first` to the transcript.
    assert nudge_for(event) is None


def test_a_denied_call_leaves_the_nudge_for_the_next_one(tmp_path):
    from claude_guard.hook import pre_tool_use

    def run(command):
        stdin = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(tmp_path)}
        stdin["transcript_path"] = str(tmp_path / "t.jsonl")
        return json.loads(pre_tool_use(json.dumps(stdin), {}))["hookSpecificOutput"]

    denied = run("git log && git push --force origin main")
    assert denied["permissionDecision"] == "deny"
    assert "additionalContext" not in denied
    assert run("git log")["additionalContext"].startswith(tag("unbounded-log"))


def test_a_subagent_gets_its_own_once_rule(tmp_path):
    from claude_guard.hook import context_transcript, nudge_for

    parent = tmp_path / "sess.jsonl"
    git_log = {"tool_input": {"command": "git log"}}
    assert nudge_for(parse_event(json.dumps({**git_log, "transcript_path": str(parent)})))
    event = parse_event(json.dumps({**git_log, "transcript_path": str(parent), "agent_id": "a1"}))
    own = tmp_path / "sess" / "subagents" / "agent-a1.jsonl"
    got = context_transcript(event)
    if sys.platform == "win32":
        # The harness splices a "/" into the path, which Windows spells with a backslash.
        got = os.path.normpath(got)
    assert got == str(own)
    # The parent had the nudge, the subagent has not: the subagent still gets it, once.
    assert nudge_for(event)
    assert nudge_for(event) is None


@pytest.fixture
def big_and_small(tmp_path):
    (tmp_path / "big.j2").write_text("x" * 30_000)
    (tmp_path / "small.j2").write_text("x" * 1_000)
    return tmp_path


@pytest.mark.parametrize(
    "command",
    [
        "cat -n {d}/big.j2",
        "cat -n big.j2",
        "cd {d}; cat -n big.j2",
        "cat small.j2 big.j2",
        "cat -n big.j2 | sort",
        "cat big.j2 2> /dev/null",
        "cat < big.j2",
        "cat <big.j2",
        "cat 0< big.j2",
    ],
)
def test_an_unbounded_cat_of_a_big_file_is_nudged(big_and_small, command):
    found = nudge(command.format(d=big_and_small), cwd=str(big_and_small))
    assert found and found[0] == "whole-file-cat"


@pytest.mark.parametrize(
    "command",
    [
        "cat -n small.j2",
        "cat < small.j2",
        "cat -n big.j2 | head -50",
        "cat big.j2 | sed -n 10,40p",
        "cat big.j2 | rg -n listen",
        "cat small.j2 big.j2 > joined.j2",
        "cat big.j2 small.j2>>joined.j2",
        "cat missing.j2",
    ],
)
def test_a_small_bounded_or_redirected_cat_is_left_alone(big_and_small, command):
    assert nudge(command, cwd=str(big_and_small)) is None


def test_a_relative_cat_without_a_cwd_is_left_alone(big_and_small):
    assert nudge("cat big.j2") is None


def test_the_hook_resolves_cat_against_the_session_cwd(big_and_small):
    from claude_guard.hook import nudge_for

    stdin = json.dumps({"tool_input": {"command": "cat big.j2"}, "cwd": str(big_and_small)})
    found = nudge_for(parse_event(stdin))
    assert found and found.startswith(tag("whole-file-cat"))


@pytest.mark.parametrize("path", ["{d}/big.j2", "big.j2"])
def test_a_whole_read_of_a_big_file_is_nudged(big_and_small, path):
    from claude_guard.nudges import read_nudge

    found = read_nudge({"file_path": path.format(d=big_and_small)}, cwd=str(big_and_small))
    assert found and found[0] == "whole-file-read"
    assert found[1].startswith(tag("whole-file-read"))


@pytest.mark.parametrize(
    "tool_input",
    [
        {"file_path": "big.j2", "offset": 100},
        {"file_path": "big.j2", "limit": 200},
        {"file_path": "small.j2"},
        {"file_path": "missing.j2"},
        {"file_path": "big.png"},
    ],
)
def test_a_bounded_small_or_non_text_read_is_left_alone(big_and_small, tool_input):
    from claude_guard.nudges import read_nudge

    (big_and_small / "big.png").write_bytes(b"x" * 30_000)
    assert read_nudge(tool_input, cwd=str(big_and_small)) is None


def test_the_read_hook_nudges_once_per_session(big_and_small, tmp_path):
    from claude_guard.hook import read_nudge_json

    transcript = tmp_path / "session.jsonl"
    transcript.write_text("{}\n")
    stdin = json.dumps(
        {
            "tool_name": "Read",
            "tool_input": {"file_path": str(big_and_small / "big.j2")},
            "transcript_path": str(transcript),
        }
    )
    out = json.loads(read_nudge_json(stdin))["hookSpecificOutput"]
    assert out["hookEventName"] == "PreToolUse"
    assert "permissionDecision" not in out
    assert out["additionalContext"].startswith(tag("whole-file-read"))
    assert read_nudge_json(stdin) is None


@pytest.fixture
def wrappers_on_path(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("gh-rerun-failed", "runlog"):
        (bin_dir / tool).write_text("#!/bin/sh\n")
        (bin_dir / tool).chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("gh run rerun 4567 --failed", "gh-rerun-failed"),
        ("gh run rerun --failed 4567 -R org/repo", "gh-rerun-failed"),
        ("uv run pytest > /tmp/a.log 2>&1", "runlog"),
        ("make >out.log 2>&1", "runlog"),
        ("make >> out.log 2>&1", "runlog"),
        ("make 1>out.log 2>&1 &", "runlog"),
        ("make &> out.log", "runlog"),
        ("make &>>out.log", "runlog"),
    ],
)
def test_a_raw_form_a_wrapper_replaces_is_nudged(command, expected, wrappers_on_path):
    assert rule(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        "gh run rerun 4567",
        "gh run view 4567 --log-failed",
        "make > /dev/null 2>&1",
        "make > out.log",
        "make 2>&1 | tee out.log",
        "cat > f <<'EOF'\nx\nEOF",
        "runlog k -- make > out.log 2>&1",
    ],
)
def test_a_form_the_wrapper_does_not_replace_is_left_alone(command, wrappers_on_path):
    assert rule(command) is None


def test_a_wrapper_nudge_needs_the_wrapper_on_path(tmp_path, monkeypatch):
    # A host can have gh without either wrapper.
    monkeypatch.setenv("PATH", str(tmp_path))
    assert rule("gh run rerun 4567 --failed") is None
    assert rule("make > out.log 2>&1") is None


def test_the_rerun_nudge_names_the_raw_form_for_a_repo_the_account_does_not_own(
    wrappers_on_path,
):
    text = nudge("gh run rerun 4567 --failed")[1]
    assert "`gh-rerun-failed <run-id>" in text and "`gh run rerun --failed`" in text


@pytest.fixture
def server_checkout(tmp_path, monkeypatch):
    """A server checkout holding both readers, with gh-quota and unitq on PATH."""
    root = tmp_path / "server"
    for script in ("scripts/diagnostics/probe.py", "scripts/dev/prune_worktrees.py"):
        (root / script).parent.mkdir(parents=True, exist_ok=True)
        (root / script).write_text("")
    (root / "ansible").mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("gh-quota", "unitq"):
        (bin_dir / tool).write_text("#!/bin/sh\n")
        (bin_dir / tool).chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))
    return root


@pytest.mark.parametrize(
    ("command", "expected", "reader"),
    [
        (
            "ghread pr list --head fix-1 --state merged",
            "landed-check",
            "prune_worktrees.py --check",
        ),
        ("git log --oneline origin/master..fix-1", "landed-check", "prune_worktrees.py --check"),
        ("pgrep -af 'land.sh --pr 8857'", "landing-inflight", "probe.py landing`"),
        ("ps aux | grep land.sh", "landing-inflight", "probe.py landing`"),
        ("tail -n 40 /tmp/land-8857.out", "landing-verdicts", "probe.py landing-verdicts"),
        ("kubectl get kustomization -A", "flux-state", "probe.py flux"),
        ("ssh daniel-server 'kubectl get ks -n flux-system'", "flux-state", "probe.py flux"),
        ("ssh daniel-pi docker ps", "pi-containers", "probe.py pi"),
        ("ssh daniel-pi 'docker inspect -f {{.State.Status}} x'", "pi-containers", "probe.py pi"),
        ("ghread api rate_limit", "gh-quota", "gh-quota status"),
        ("systemctl show -p ActiveState k3s.service", "unit-state", "unitq show"),
        ("sudo systemctl show nginx --property=User", "unit-state", "unitq show"),
    ],
)
def test_a_raw_state_read_is_pointed_at_its_reader(server_checkout, command, expected, reader):
    found = nudge(command, cwd=str(server_checkout / "ansible"))
    assert found and found[0] == expected
    assert reader in found[1]


@pytest.mark.parametrize(
    "command",
    [
        "git log origin/master..HEAD",
        "ghread pr list --state open",
        "ps aux | grep nginx",
        "tail -n 5 /var/log/syslog",
        "kubectl get pods -A",
        "ssh daniel-server docker ps",
        "ghread api repos/o/r/pulls",
        "systemctl status k3s",
        "ssh daniel-server systemctl show -p User k3s",
    ],
)
def test_a_state_read_with_no_reader_row_is_left_alone(server_checkout, command):
    assert nudge(command, cwd=str(server_checkout)) is None


@pytest.mark.parametrize(
    ("first_line", "expected"),
    [
        ("land --detach: running in background (pid 2777776).", "landing-verdicts"),
        ("land: 3 landings are already live for orchestrator 'default'.", "landing-verdicts"),
        ("============================= test session starts", None),
    ],
)
def test_a_tail_of_a_task_output_file_is_judged_by_its_first_line(
    server_checkout, tmp_path, first_line, expected
):
    output = tmp_path / "tasks" / "b3kj4avn7.output"
    output.parent.mkdir()
    output.write_text(first_line + "\n14:20:52 running: arm\n")
    found = nudge(f"tail -n 50 {output}", cwd=str(server_checkout))
    assert (found and found[0]) == expected


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs named pipes")
def test_a_tail_of_a_fifo_returns_without_opening_it(server_checkout, tmp_path):
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)
    result = []
    worker = threading.Thread(
        target=lambda: result.append(nudge(f"tail -f {fifo}", cwd=str(server_checkout))),
        daemon=True,
    )
    worker.start()
    worker.join(timeout=2)
    assert result == [None]


def test_a_server_reader_row_stays_silent_outside_a_server_checkout(server_checkout, tmp_path):
    for command in ("kubectl get kustomization -A", "git log origin/master..fix-1"):
        assert nudge(command, cwd=str(tmp_path)) is None
        assert nudge(command) is None


def test_a_cd_into_a_server_checkout_arms_its_rows(server_checkout, tmp_path):
    found = nudge(f"cd {server_checkout} && kubectl get kustomization -A", cwd=str(tmp_path))
    assert found and found[0] == "flux-state"


def test_a_host_tool_row_needs_its_tool_on_path(server_checkout, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    assert nudge("ghread api rate_limit", cwd=str(server_checkout)) is None
    assert nudge("systemctl show -p User k3s", cwd=str(server_checkout)) is None


def test_the_hook_points_a_raw_read_at_its_reader_in_the_session_cwd(server_checkout):
    from claude_guard.hook import pre_tool_use

    command = "kubectl get kustomization -A"
    stdin = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": str(server_checkout)}
    out = json.loads(pre_tool_use(json.dumps(stdin), {}))["hookSpecificOutput"]
    assert out["additionalContext"].startswith(tag("flux-state"))


def _executable(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


@pytest.fixture
def path_grep_is_gnu(monkeypatch):
    monkeypatch.setattr(nudges, "_grep_is_ugrep", lambda: False)
    monkeypatch.delenv("CLAUDE_CODE_EXECPATH", raising=False)


@pytest.fixture
def snapshot_grep_is_ugrep(tmp_path, monkeypatch, path_grep_is_gnu):
    """daniel-box: PATH grep is GNU, and the snapshot's grep runs the claude binary."""
    monkeypatch.setenv("CLAUDE_CODE_EXECPATH", str(_executable(tmp_path / "claude-2.1")))


@pytest.mark.parametrize(
    "command",
    [
        """grep -E 'x[^"]{0,20}y[^"]{0,20}z' log.txt | wc -l""",
        """grep -rhoE '"command":"[^"\\\\]{0,80}' ~/notes""",
        """grep 'x[^"]\\{0,80\\}y' f""",
        """grep -E 'x[^[:space:]]{0,20}y' f""",
        """grep -E 'x[^]"]{0,20}y' f""",
        """ugrep '[^a]{2,9}b' f""",
    ],
)
def test_a_bounded_negated_class_is_nudged_where_the_bash_tool_grep_is_ugrep(
    command, snapshot_grep_is_ugrep
):
    assert rule(command) == "ugrep-bounded-class"


def test_the_snapshot_binary_falls_back_to_the_local_bin_claude(marker_home, path_grep_is_gnu):
    _executable(marker_home / ".local/bin/claude")
    assert rule("""grep -E 'x[^"]{0,20}y' f""") == "ugrep-bounded-class"


@pytest.mark.parametrize(
    "command",
    [
        """grep -P 'x[^"]{0,20}y[^"]{0,20}z' f""",
        """grep -E 'x[^"]*y' f""",
        """grep -E '[a-z]{0,8}' f""",
        """grep '[^"]{0,8}' f""",
    ],
)
def test_a_pattern_ugrep_compiles_is_left_alone(command, snapshot_grep_is_ugrep):
    assert rule(command) is None


def test_a_bounded_negated_class_is_left_alone_without_any_ugrep(path_grep_is_gnu):
    assert rule("""grep -E 'x[^"]{0,20}y[^"]{0,20}z' f""") is None
