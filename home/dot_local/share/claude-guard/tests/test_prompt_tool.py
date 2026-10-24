"""The headless permission prompt: claude_guard.prompt_tool's verdicts and its cwd record."""

import io
import json
import os
from pathlib import Path

from test_git_reset import _make_repo

from claude_guard import prompt_tool
from claude_guard.hook import pre_tool_use


def home_with(tmp_path: Path, perms: dict) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"permissions": perms}))
    return home


def env_for(home: Path, **extra: str) -> dict[str, str]:
    return {"HOME": str(home), "PATH": "/usr/bin:/bin", **extra}


def request(command: str, tool_use_id: str = "toolu_1", tool: str = "Bash") -> dict:
    return {"tool_name": tool, "input": {"command": command}, "tool_use_id": tool_use_id}


def hook_payload(command: str, cwd: str, tool_use_id: str = "toolu_1") -> str:
    return json.dumps(
        {
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "cwd": cwd,
            "tool_use_id": tool_use_id,
        }
    )


ASK_RM = {"allow": [], "deny": [], "ask": ["Bash(rm:*)"]}


def test_a_command_the_judge_allows_is_allowed_with_its_input_unchanged(tmp_path):
    home = home_with(tmp_path, ASK_RM)
    job = str(home / ".claude" / "jobs" / "abc123")
    req = request('rm -rf "$CLAUDE_JOB_DIR/tmp/body.md"')
    req["input"]["description"] = "drop the draft"
    verdict = prompt_tool.decide(req, env_for(home, CLAUDE_JOB_DIR=job))
    assert verdict == {"behavior": "allow", "updatedInput": req["input"]}


def test_a_command_the_judge_defers_is_denied(tmp_path):
    home = home_with(tmp_path, ASK_RM)
    verdict = prompt_tool.decide(
        request("gh variable set DEPLOY_HOLD --body none -R DanielH2018/server"), env_for(home)
    )
    assert verdict == {"behavior": "deny", "message": prompt_tool.DENY_MESSAGE}


def test_a_tool_other_than_bash_is_denied(tmp_path):
    home = home_with(tmp_path, ASK_RM)
    req = {"tool_name": "Write", "input": {"file_path": "/etc/x", "content": ""}}
    assert prompt_tool.decide(req, env_for(home))["behavior"] == "deny"


def test_a_malformed_request_is_denied(tmp_path):
    env = env_for(home_with(tmp_path, ASK_RM))
    for bad in (None, [], {"tool_name": "Bash"}, {"tool_name": "Bash", "input": {"command": 3}}):
        assert prompt_tool.decide(bad, env)["behavior"] == "deny"


def test_the_pre_tool_use_record_carries_the_cwd_to_the_prompt_and_is_consumed(tmp_path):
    # `git reset --hard origin/master` is allowed only in a clean checkout named by the cwd,
    # so the allow proves the recorded cwd reached the judge.
    home = home_with(tmp_path, {"allow": [], "deny": [], "ask": []})
    work = _make_repo(tmp_path)
    env = env_for(home)
    pre_tool_use(hook_payload("git reset --hard origin/master", work), env)
    req = request("git reset --hard origin/master")
    assert prompt_tool.decide(req, env)["behavior"] == "allow"
    assert prompt_tool.decide(req, env)["behavior"] == "deny"


def test_with_no_record_the_judge_gets_an_empty_cwd_and_refuses(tmp_path, monkeypatch):
    home = home_with(tmp_path, {"allow": [], "deny": [], "ask": []})
    work = _make_repo(tmp_path)
    monkeypatch.chdir(work)
    verdict = prompt_tool.decide(
        request("git reset --hard origin/master", "toolu_none"), env_for(home)
    )
    assert verdict["behavior"] == "deny"


def test_records_older_than_an_hour_are_pruned_on_write(tmp_path):
    env = env_for(home_with(tmp_path, ASK_RM))
    prompt_tool.record_context(hook_payload("ls", "/tmp", "toolu_old"), env, now=0)
    old = prompt_tool.context_dir(env) / "toolu_old.json"
    os.utime(old, (0, 0))
    prompt_tool.record_context(hook_payload("ls", "/tmp", "toolu_new"), env)
    assert not old.exists()
    assert (prompt_tool.context_dir(env) / "toolu_new.json").exists()
    assert oct(prompt_tool.context_dir(env).stat().st_mode & 0o777) == "0o700"


def test_a_tool_use_id_that_is_not_a_plain_name_is_never_a_path(tmp_path):
    env = env_for(home_with(tmp_path, ASK_RM))
    prompt_tool.record_context(hook_payload("ls", "/tmp", "../../escape"), env)
    assert not (Path(env["HOME"]) / ".cache" / "escape.json").exists()
    assert prompt_tool.take_context("../../escape", env) == ("", {})


def test_the_server_answers_initialize_list_and_call_over_stdio(tmp_path):
    env = env_for(home_with(tmp_path, ASK_RM))
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "x"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "decide", "arguments": request("rm /etc/passwd")},
        },
    ]
    out = io.StringIO()
    prompt_tool.serve(io.StringIO("".join(json.dumps(m) + "\n" for m in lines)), out, env)
    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[1]["result"]["tools"][0]["name"] == "decide"
    verdict = json.loads(replies[2]["result"]["content"][0]["text"])
    assert verdict["behavior"] == "deny"
