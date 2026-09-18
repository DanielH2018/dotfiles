"""The PermissionRequest contract: stdin JSON in, a decision line or nothing out.

Function-level here; Task 6 appends the tests that drive the shim as a subprocess with a
temp HOME the way tests/hooks/allow-compound-bash.test.js drives the bash hook.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from test_git_reset import _make_repo

from claude_guard import hook
from claude_guard.deny import NONE, Verdict
from claude_guard.hook import (
    ALLOW_JSON,
    ASK_JSON,
    permission_request,
    pre_tool_use,
    pre_tool_use_json,
    read_cwd,
)

PKG_DIR = Path(__file__).resolve().parents[1]
HOOKS = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"

PERMS = {
    "allow": ["Bash(git status:*)", "Bash(ls:*)", "Bash(echo:*)"],
    "deny": ["Bash(rm:*)"],
    "ask": [],
}


def home_with(tmp_path: Path, perms: dict = PERMS) -> Path:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"permissions": perms}))
    return home


def payload(command: str) -> str:
    return json.dumps({"tool_input": {"command": command}})


def env_for(home: Path, **extra: str) -> dict[str, str]:
    return {"HOME": str(home), "PATH": "/usr/bin:/bin", **extra}


# --- live mode -----------------------------------------------------------------------------


def test_live_mode_prints_the_allow_line_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    assert permission_request(payload("git status && ls"), env_for(home)) == ALLOW_JSON


def test_live_mode_prints_nothing_for_a_refused_chain(tmp_path):
    home = home_with(tmp_path)
    assert permission_request(payload("git status && rm -rf /"), env_for(home)) is None


def test_malformed_or_command_less_stdin_is_no_decision(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home)
    assert permission_request("{ not json", env) is None
    assert permission_request(json.dumps({"tool_input": {}}), env) is None
    assert permission_request(json.dumps({"tool_input": {"command": 5}}), env) is None
    assert permission_request("", env) is None


# --- cwd threading (fix round 1, F5) ----------------------------------------------------------
#
# `grep -rn "read_cwd" tests/` returned nothing before this: the entire production cwd
# threading (hook.py's read_cwd, and permission_request passing it into decide()) could be
# deleted unnoticed. Mutating hook.py's read_cwd to always return "" must turn this red.


def test_read_cwd_extracts_the_top_level_cwd():
    assert read_cwd(json.dumps({"cwd": "/home/testuser/proj", "tool_input": {}})) == (
        "/home/testuser/proj"
    )


def test_read_cwd_is_empty_on_a_missing_key_a_non_dict_payload_or_unparseable_json():
    assert read_cwd(json.dumps({"tool_input": {"command": "ls"}})) == ""
    assert read_cwd(json.dumps([1, 2, 3])) == ""
    assert read_cwd("{ not json") == ""


def test_permission_request_threads_the_sessions_cwd_into_the_decision(tmp_path):
    # A real, clean repo makes `git reset --hard origin/master` allow ONLY when the hook
    # actually read `.cwd` off the stdin payload and passed it through decide()/judge() to
    # clean_reset_safe -- a `cwd = ""` mutation at hook.py's read_cwd call site would make
    # this refuse instead (F1 now refuses "" outright, rather than silently probing the
    # hook process's own cwd the way it used to).
    home = home_with(tmp_path)
    work = _make_repo(tmp_path)
    stdin = json.dumps({"tool_input": {"command": "git reset --hard origin/master"}, "cwd": work})
    assert permission_request(stdin, env_for(home)) == ALLOW_JSON


# --- the shim, driven as the harness drives it ---------------------------------------------

SHIM = HOOKS / "executable_guard-permission-request.sh"
BASH = shutil.which("bash") or "/bin/bash"
skip_no_uv = pytest.mark.skipif(not shutil.which("uv"), reason="uv unavailable")


def run_shim(
    stdin_text: str, env: dict[str, str], cwd: Path | None = None
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(SHIM)], input=stdin_text, capture_output=True, text=True, env=env, cwd=cwd
    )


def shim_env(home: Path, **extra: str) -> dict[str, str]:
    # XDG_DATA_HOME pins uv's managed-python lookup to the REAL home's install dir: `uv python
    # find` derives its search path from $HOME (or $XDG_DATA_HOME) at call time, so a fake HOME
    # here (needed so permission_request() reads an isolated settings.json) would otherwise make
    # the managed 3.14 toolchain undiscoverable, independent of the shim's own behaviour.
    return {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "XDG_DATA_HOME": str(Path.home() / ".local" / "share"),
        "CLAUDE_GUARD_HOME": str(PKG_DIR),
        "CLAUDE_GUARD_BASH_HOOKS_DIR": str(HOOKS),
        **extra,
    }


@skip_no_uv
def test_shim_prints_the_allow_line_live(tmp_path):
    # The shim is live-only -- slice 6 retired CLAUDE_GUARD_SHADOW and the switch it fed, so
    # there is no variable left to set here (module docstring, claude_guard.hook).
    home = home_with(tmp_path)
    r = run_shim(payload("git status && ls"), shim_env(home))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


def test_shim_prints_nothing_and_exits_zero_without_an_interpreter(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, PATH="/nonexistent")
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")


@skip_no_uv
def test_shim_prints_nothing_and_exits_zero_when_the_package_is_missing(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")


def shim_lookup_argv(shim_path: Path) -> list[str]:
    """Extract the `uv python find ...` argv straight from a shim's own source text, so this
    test tracks whatever flags the shim actually passes rather than a hand-copied duplicate
    that could silently drift out of sync with it."""
    text = shim_path.read_text()
    m = re.search(r"uv python find ((?:\S+\s*)+)", text)
    assert m, f"no `uv python find` invocation found in {shim_path}"
    tokens = []
    for tok in m.group(1).split():
        if tok.startswith("2>") or tok in ("||", ")"):
            break
        tokens.append(tok)
    return ["uv", "python", "find", *tokens]


@skip_no_uv
def test_the_shims_lookup_ignores_a_real_cwd_venv_only_because_of_system(tmp_path):
    # A *dangling* or wrong-version cwd venv is not the risk `--system` guards against: uv
    # already probes a discovered venv's interpreter and falls back to the managed toolchain
    # on its own regardless of `--system` (measured directly against this shim before adding
    # this test). The one shape that actually differs is a REAL, version-matching venv found
    # by walking up from cwd -- exactly what a project's own `.venv` is -- which uv prefers
    # over the managed install unless `--system` is present.
    argv = shim_lookup_argv(SHIM)
    assert "--system" in argv, argv

    venv = tmp_path / ".venv"
    created = subprocess.run(
        ["uv", "venv", "--python", "3.14", str(venv)], capture_output=True, text=True
    )
    if created.returncode != 0:
        pytest.skip(f"uv venv --python 3.14 unavailable: {created.stderr}")

    # This test file itself runs under `uv run --no-project --python 3.14 ...`, which sets
    # VIRTUAL_ENV to ITS OWN ephemeral build env -- an explicit activation that would outrank
    # cwd discovery either way and mask what we're testing. The real hook shim never runs
    # inside a `uv run` wrapper, so strip it to match that ambient reality.
    clean_env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}

    r = subprocess.run(argv, capture_output=True, text=True, cwd=tmp_path, env=clean_env)
    assert r.returncode == 0, r.stderr
    found = Path(r.stdout.strip())
    assert tmp_path not in found.parents, f"got the cwd venv instead of managed: {found}"
    assert "/uv/python/" in str(found), found
    assert found.is_file(), found

    # Control: the fixture must actually discriminate -- without --system the same lookup,
    # from the same cwd, must prefer the venv it just proved --system skips. If uv's own
    # preference for a cwd venv ever changes, skip visibly rather than pass for no reason.
    argv_no_system = [a for a in argv if a != "--system"]
    r2 = subprocess.run(argv_no_system, capture_output=True, text=True, cwd=tmp_path, env=clean_env)
    if r2.returncode != 0:
        pytest.skip("uv python find without --system did not return 0; behaviour changed")
    found2 = Path(r2.stdout.strip())
    if tmp_path not in found2.parents:
        pytest.skip(
            "uv no longer prefers a cwd venv without --system; the control no longer discriminates"
        )
    assert tmp_path in found2.parents


# =============================================================================================
# The PreToolUse side (slice 4): deny rules and the deny-path failure contract. Live only:
# slice 6 deleted the block-dangerous-bash.sh this side shadowed and the shadow with it.
# =============================================================================================


def denv(home: Path, **extra: str) -> dict[str, str]:
    return env_for(home, **extra)


# --- the stdout contract (:601-611, hook-input.sh:83, :1133-1140) -----------------------------


def test_pre_tool_use_json_prints_the_deny_shape_the_bash_prints():
    out = json.loads(pre_tool_use_json(Verdict("deny", "rm-root", "Blocked: x")))
    assert out == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Blocked: x",
        }
    }


def test_pre_tool_use_json_prints_the_allow_shape_with_updated_input():
    v = Verdict(
        "allow",
        "force-push-upgrade",
        "",
        updated_command="git push --force-with-lease o b",
        context="NOTE",
    )
    out = json.loads(pre_tool_use_json(v))["hookSpecificOutput"]
    assert out["permissionDecision"] == "allow"
    assert out["updatedInput"] == {"command": "git push --force-with-lease o b"}
    assert out["additionalContext"] == "NOTE"
    assert "permissionDecisionReason" not in out


def test_pre_tool_use_json_prints_nothing_for_none():
    assert pre_tool_use_json(NONE) is None


def test_ask_json_is_the_ask_shape():
    out = json.loads(ASK_JSON)["hookSpecificOutput"]
    assert (out["hookEventName"], out["permissionDecision"]) == ("PreToolUse", "ask")
    assert "could not be evaluated" in out["permissionDecisionReason"]


# --- live mode ---------------------------------------------------------------------------------


def test_live_mode_prints_the_deny_line_for_a_dangerous_command(tmp_path):
    home = home_with(tmp_path)
    out = pre_tool_use(payload("rm -rf /"), denv(home))
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_live_mode_prints_nothing_for_a_benign_command(tmp_path):
    home = home_with(tmp_path)
    assert pre_tool_use(payload("ls -la"), denv(home)) is None


def test_live_mode_prints_the_upgrade_for_a_feature_branch_force_push(tmp_path):
    home = home_with(tmp_path)
    env = denv(home)
    out = pre_tool_use(payload("git push --force origin feat"), env)
    assert json.loads(out)["hookSpecificOutput"]["updatedInput"]["command"].endswith(
        "--force-with-lease origin feat"
    )


def test_live_mode_prints_nothing_for_unparseable_stdin(tmp_path):
    # :22-23: jq yields an empty command and the bash exits 0 with no decision.
    home = home_with(tmp_path)
    assert pre_tool_use("not json", denv(home)) is None


def test_live_mode_turns_an_exception_into_ask(tmp_path, monkeypatch):
    # The deny side fails CLOSED to ask (spec, Failure contracts). A crash must never read as
    # "nothing to worry about here".
    def boom(command, cwd="", env=None):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(hook, "deny", boom)
    home = home_with(tmp_path)
    assert pre_tool_use(payload("ls"), denv(home)) == ASK_JSON


# --- the PreToolUse shim, driven as the harness drives it --------------------------------------

DENY_SHIM = HOOKS / "executable_guard-pre-tool-use.sh"


def run_deny_shim(stdin_text: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [BASH, str(DENY_SHIM)], input=stdin_text, capture_output=True, text=True, env=env
    )


def decision(stdout: str) -> str | None:
    if not stdout.strip():
        return None
    return json.loads(stdout)["hookSpecificOutput"]["permissionDecision"]


@skip_no_uv
def test_deny_shim_prints_the_deny_line(tmp_path):
    home = home_with(tmp_path)
    r = run_deny_shim(payload("rm -rf /"), shim_env(home))
    assert r.returncode == 0, r.stderr
    assert decision(r.stdout) == "deny"


@skip_no_uv
def test_deny_shim_prints_nothing_for_a_benign_command(tmp_path):
    home = home_with(tmp_path)
    r = run_deny_shim(payload("ls -la"), shim_env(home))
    assert (r.returncode, r.stdout) == (0, "")


def test_deny_shim_asks_without_an_interpreter(tmp_path):
    # Spec, Failure contracts, claude-guard deny path: the shim emits ask ITSELF, without
    # Python. PATH has no uv and no python; only bash builtins run.
    home = home_with(tmp_path)
    env = shim_env(home, PATH="/nonexistent")
    r = run_deny_shim(payload("rm -rf /"), env)
    assert r.returncode == 0
    assert decision(r.stdout) == "ask"


def test_deny_shim_asks_when_the_package_is_missing(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
    r = run_deny_shim(payload("rm -rf /"), env)
    assert (r.returncode, decision(r.stdout)) == (0, "ask")


@skip_no_uv
def test_deny_shim_asks_when_python_exits_non_zero(tmp_path):
    # A package whose cli.py dies before the hook's own try/except: the shim, not Python,
    # owns the ask. Built as a real package so the shim's own `-f cli.py` check passes.
    fake = tmp_path / "fake" / "claude_guard"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text("")
    (fake / "cli.py").write_text("import sys\nsys.exit(3)\n")
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_HOME=str(tmp_path / "fake"))
    r = run_deny_shim(payload("rm -rf /"), env)
    assert (r.returncode, decision(r.stdout)) == (0, "ask")


def test_deny_shim_asks_on_failure_whatever_a_stale_shadow_variable_says(tmp_path):
    # Slice 4's CLAUDE_GUARD_DENY_SHADOW made a failure silent when set to anything but "0".
    # Slice 6 retired the switch with the bash it shadowed; a settings.json generated before
    # that may still export it, and it must not turn the ask back into silence.
    home = home_with(tmp_path)
    for env in (
        shim_env(home, PATH="/nonexistent", CLAUDE_GUARD_DENY_SHADOW="1"),
        shim_env(home, CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"), CLAUDE_GUARD_DENY_SHADOW="1"),
    ):
        r = run_deny_shim(payload("rm -rf /"), env)
        assert (r.returncode, decision(r.stdout)) == (0, "ask")
