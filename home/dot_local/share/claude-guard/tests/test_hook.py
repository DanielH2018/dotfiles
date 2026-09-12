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
    DENY_LOG_NAME,
    LOG_NAME,
    bash_deny_verdict,
    deny_shadow_record,
    permission_request,
    pre_tool_use,
    pre_tool_use_json,
    read_cwd,
    shadow_mode,
    summarize,
    summarize_deny,
)
from claude_guard.judge import Decision

PKG_DIR = Path(__file__).resolve().parents[1]
HOOKS = PKG_DIR.parents[3] / "home" / "private_dot_claude" / "hooks"

skip_no_bash = pytest.mark.skipif(
    not (
        shutil.which("bash")
        and shutil.which("jq")
        and (HOOKS / "executable_allow-compound-bash.sh").exists()
    ),
    reason="bash chain unavailable",
)

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
    assert (
        permission_request(payload("git status && ls"), env_for(home, CLAUDE_GUARD_SHADOW="0"))
        == ALLOW_JSON
    )


def test_live_mode_prints_nothing_for_a_refused_chain(tmp_path):
    home = home_with(tmp_path)
    assert (
        permission_request(
            payload("git status && rm -rf /"), env_for(home, CLAUDE_GUARD_SHADOW="0")
        )
        is None
    )


def test_malformed_or_command_less_stdin_is_no_decision(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="0")
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
    assert permission_request(stdin, env_for(home, CLAUDE_GUARD_SHADOW="0")) == ALLOW_JSON


# --- the env contract ----------------------------------------------------------------------


def test_shadow_mode_is_on_unless_the_variable_is_exactly_0():
    assert shadow_mode({}) == (True, True)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "0"}) == (False, False)
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1"}) == (True, True)


def test_shadow_mode_stays_shadow_for_anything_that_is_not_exactly_0():
    # Fail-safe: a typo or a truthy-looking non-"0" value must never fall through to live.
    for value in ("true", "01", "yes", " 1"):
        assert shadow_mode({"CLAUDE_GUARD_SHADOW": value}) == (True, True), value


def test_sampling_governs_logging_only_and_the_roll_seam_picks_the_branch():
    on = {"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "10"}
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "0"}) == (True, True)
    assert shadow_mode({**on, "CLAUDE_GUARD_SHADOW_ROLL": "3"}) == (True, False)
    # A malformed denominator falls back to logging every call, never to deciding.
    assert shadow_mode({"CLAUDE_GUARD_SHADOW": "1", "CLAUDE_GUARD_SHADOW_SAMPLE": "x"}) == (
        True,
        True,
    )


# --- shadow mode ---------------------------------------------------------------------------


@skip_no_bash
def test_shadow_mode_prints_nothing_and_logs_one_line_that_agrees_with_the_bash_chain(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    lines = (log_dir / LOG_NAME).read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["python"] == "allow" and rec["bash"] == "allow"
    assert rec["bash_hook"] == "allow-compound-bash.sh"
    assert rec["rule"] == "allow"
    assert len(rec["cmd_sha"]) == 16 and rec["ts"].endswith("Z")


@skip_no_bash
def test_shadow_mode_agrees_on_a_readonly_remote_and_an_ansible_check(tmp_path):
    # Fix round 1, F3 red-proof, measured against the REAL bash hooks (HOOKS, the chezmoi
    # source `allow-readonly-remote.sh`/`allow-ansible-readonly.sh`), not a fake chain.
    # Before F3, BASH_CHAIN held only allow-compound-bash.sh/allow-safe-curl.sh/
    # allow-safe-rm.sh, none of which ever answers "allow" for either command below, so
    # judge()'s own F0 remote/ansible checks (ported in Task 7) made these read
    # `python_only` in the shadow census -- an artefact of this list being incomplete,
    # never a real python/bash disagreement. Revert BASH_CHAIN to the 3-entry list and
    # `bash` drops to "none"/`bash_hook` to None on both lines below.
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"

    assert permission_request(payload("ssh daniel-server uptime"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text().splitlines()[-1])
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == (
        "allow",
        "allow",
        "allow-readonly-remote.sh",
    )

    assert (
        permission_request(payload("ansible-playbook site.yml --check"), env, log_dir=log_dir)
        is None
    )
    rec = json.loads((log_dir / LOG_NAME).read_text().splitlines()[-1])
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == (
        "allow",
        "allow",
        "allow-ansible-readonly.sh",
    )


# Item 2 (fix round 2): F3's only red-proof for BASH_CHAIN's three-hook widening is the
# @skip_no_bash-gated test above, and plan Task 8 step 3 deletes the file that gate probes
# for (executable_allow-compound-bash.sh) -- after Task 8 that test skips silently and
# forever on every runner, while BASH_CHAIN and bash_chain_allows stay live for
# `replay --compare-hooks`. On any runner without `jq` it already skips today, so F3 has
# ZERO red-proof there right now. `grep -rn BASH_CHAIN tests/` otherwise turns up only
# that test's own comment and the two `for name in hook.BASH_CHAIN` loops below, which
# iterate whatever length the tuple has -- a shrunk tuple moves a count, never names the
# missing member. This asserts the six required names as a frozenset, unconditionally (no
# bash/jq/HOOKS dependency), so a dropped member fails by NAME.
_REQUIRED_BASH_CHAIN_HOOKS = frozenset(
    {
        "allow-compound-bash.sh",
        "allow-safe-curl.sh",
        "allow-safe-rm.sh",
        "allow-readonly-remote.sh",
        "allow-daniel-server.sh",
        "allow-ansible-readonly.sh",
    }
)


def test_bash_chain_names_every_deployed_hook_it_must_shadow():
    missing = _REQUIRED_BASH_CHAIN_HOOKS - set(hook.BASH_CHAIN)
    assert not missing, f"BASH_CHAIN dropped: {sorted(missing)}"


@skip_no_bash
def test_shadow_mode_logs_a_refusal_both_sides_agree_on(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(HOOKS))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && rm -rf /"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == ("none", "none", None)
    assert rec["rule"] == "segment:1:deny"


def test_shadow_log_records_a_disagreement_so_the_comparison_can_go_red(tmp_path):
    # A fake bash chain that allows everything: python says none, bash says allow.
    fake = tmp_path / "hooks"
    fake.mkdir()
    for name in hook.BASH_CHAIN:
        p = fake / name
        p.write_text(
            "#!/bin/bash\ncat >/dev/null\n"
            'printf \'{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}\\n\'\n'
        )
        p.chmod(0o755)
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && frobnicate"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["bash_hook"]) == (
        "none",
        "allow",
        "allow-compound-bash.sh",
    )


def test_the_shadow_log_never_carries_the_command(tmp_path):
    fake = tmp_path / "hooks"
    fake.mkdir()  # no hooks at all: bash side is "none"
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    permission_request(payload("git status && ls /very/secret/path"), env, log_dir=log_dir)
    text = (log_dir / LOG_NAME).read_text()
    assert "secret" not in text
    assert set(json.loads(text)) == {"ts", "cmd_sha", "python", "bash", "rule", "bash_hook"}


def test_a_sampled_miss_still_decides_nothing_and_writes_nothing(tmp_path):
    home = home_with(tmp_path)
    env = env_for(
        home,
        CLAUDE_GUARD_SHADOW="1",
        CLAUDE_GUARD_SHADOW_SAMPLE="10",
        CLAUDE_GUARD_SHADOW_ROLL="7",
        CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path),
    )
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    assert not (log_dir / LOG_NAME).exists()


def test_an_unwritable_log_dir_is_swallowed(tmp_path):
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path))
    blocked = tmp_path / "file-not-dir"
    blocked.write_text("")
    assert permission_request(payload("git status && ls"), env, log_dir=blocked / "logs") is None


def test_a_decision_exception_in_shadow_still_leaves_a_record(tmp_path, monkeypatch, capsys):
    # Red-proof for finding 2: an exception raised inside decide() must not vanish the
    # way it would in live mode -- shadow's whole point is a record of every call.
    #
    # Item 3 (fix round 2): this carried a stale 2-arg signature against the real call
    # site, hook.py:231's `decide(command, cwd, env)` -- monkeypatch.setattr swaps in
    # whatever signature is written here, so the test passed on the resulting
    # `TypeError: boom() takes 2 positional arguments but 3 were given` rather than the
    # ValueError it names below.
    def boom(command, cwd, env):
        raise ValueError("should never reach the log")

    monkeypatch.setattr(hook, "decide", boom)
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert rec["python"] == "error"
    assert rec["rule"] == "exception"
    assert "should never reach the log" not in json.dumps(rec)
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


def _fake_chain(tmp_path: Path, script: str) -> Path:
    """A hooks dir where every BASH_CHAIN member is `script`, so the first one hit governs."""
    fake = tmp_path / "hooks"
    fake.mkdir()
    for name in hook.BASH_CHAIN:
        p = fake / name
        p.write_text(script)
        p.chmod(0o755)
    return fake


def test_a_bash_hook_that_exits_nonzero_is_treated_as_no_allow(tmp_path, monkeypatch):
    fake = _fake_chain(tmp_path, "#!/bin/bash\ncat >/dev/null\nexit 1\n")
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    # Live mode too: a bash-chain hook failing must not be mistaken for a python decision.
    assert (
        permission_request(payload("git status && ls"), env_for(home, CLAUDE_GUARD_SHADOW="0"))
        is not None
    )
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert rec["bash"] == "none" and rec["bash_hook"] is None


def test_a_bash_hook_that_hangs_past_the_timeout_is_treated_as_no_allow(tmp_path, monkeypatch):
    monkeypatch.setattr(hook, "_HOOK_TIMEOUT", 0.2)
    fake = _fake_chain(tmp_path, "#!/bin/bash\ncat >/dev/null\nsleep 5\n")
    home = home_with(tmp_path)
    env = env_for(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_GUARD_BASH_HOOKS_DIR=str(fake))
    log_dir = tmp_path / "logs"
    assert permission_request(payload("git status && ls"), env, log_dir=log_dir) is None
    rec = json.loads((log_dir / LOG_NAME).read_text())
    assert rec["bash"] == "none" and rec["bash_hook"] is None


# --- shadow-report -------------------------------------------------------------------------


def test_summarize_counts_agreement_and_names_the_rules_behind_each_disagreement():
    rows = [
        {
            "python": "allow",
            "bash": "allow",
            "rule": "allow",
            "bash_hook": "allow-compound-bash.sh",
        },
        {"python": "none", "bash": "none", "rule": "segment:1:deny", "bash_hook": None},
        {
            "python": "none",
            "bash": "allow",
            "rule": "segment:0:redirect",
            "bash_hook": "allow-safe-curl.sh",
        },
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
        {"python": "allow", "bash": "none", "rule": "allow", "bash_hook": None},
    ]
    s = summarize(json.dumps(r) for r in rows)
    assert s["records"] == 5
    assert s["agree"] == 2 and s["agree_allow"] == 1 and s["agree_none"] == 1
    assert s["python_only"] == 2 and s["bash_only"] == 1
    assert s["python_only_rules"] == {"allow": 2}
    assert s["bash_only_rules"] == {"segment:0:redirect (allow-safe-curl.sh)": 1}
    assert s["python_error"] == 0


def test_summarize_counts_python_error_in_its_own_bucket():
    # A python-error row must not be folded into bash-only: the python side didn't
    # disagree with bash, it never rendered a verdict at all.
    rows = [
        {"python": "allow", "bash": "allow", "rule": "allow", "bash_hook": "x"},
        {"python": "error", "bash": "allow", "rule": "exception", "bash_hook": "x"},
        {"python": "error", "bash": "none", "rule": "exception", "bash_hook": None},
    ]
    s = summarize(json.dumps(r) for r in rows)
    assert s["records"] == 3
    assert s["python_error"] == 2
    assert s["agree"] == 1
    assert s["python_only"] == 0 and s["bash_only"] == 0


def test_summarize_skips_an_unparseable_line_and_reports_it():
    s = summarize(
        ["{ nope", json.dumps({"python": "none", "bash": "none", "rule": "x", "bash_hook": None})]
    )
    assert s["records"] == 1 and s["unparseable"] == 1


def test_summarize_treats_a_non_dict_or_keyless_record_as_unparseable():
    lines = [json.dumps(v) for v in (5, [1, 2], {})]
    good = json.dumps({"python": "none", "bash": "none", "rule": "x", "bash_hook": None})
    s = summarize([*lines, good])
    assert s["records"] == 1
    assert s["unparseable"] == 3
    assert s["agree"] == 1 and s["agree_none"] == 1


def test_shadow_record_shape():
    rec = hook.shadow_record("ls; pwd", Decision(True, "allow", ("allow-list", "allow-list")), None)
    assert rec["python"] == "allow" and rec["bash"] == "none" and rec["rule"] == "allow"
    assert rec["cmd_sha"] == hook.command_sha("ls; pwd")


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
def test_shim_prints_the_allow_line_when_told_to_run_live(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(payload("git status && ls"), shim_env(home, CLAUDE_GUARD_SHADOW="0"))
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["hookSpecificOutput"]["decision"]["behavior"] == "allow"


@skip_no_uv
def test_shim_defaults_to_shadow_when_the_variable_is_absent(tmp_path):
    home = home_with(tmp_path)
    r = run_shim(
        payload("git status && ls"), shim_env(home, CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    )
    assert (r.returncode, r.stdout) == (0, "")
    assert (tmp_path / "logs" / LOG_NAME).exists()


@skip_no_uv
def test_shim_in_shadow_prints_nothing_for_an_allowed_chain(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")
    rec = json.loads((tmp_path / "logs" / LOG_NAME).read_text())
    assert rec["python"] == "allow"


def test_shim_prints_nothing_and_exits_zero_without_an_interpreter(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", PATH="/nonexistent")
    r = run_shim(payload("git status && ls"), env)
    assert (r.returncode, r.stdout) == (0, "")


@skip_no_uv
def test_shim_prints_nothing_and_exits_zero_when_the_package_is_missing(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_SHADOW="0", CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
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
# The PreToolUse side (slice 4): deny rules, their own shadow, the deny-path failure contract
# =============================================================================================

DENY_HOOK_SRC = HOOKS / "executable_block-dangerous-bash.sh"
skip_no_deny_bash = pytest.mark.skipif(
    not (shutil.which("bash") and shutil.which("jq") and DENY_HOOK_SRC.exists()),
    reason="bash deny hook unavailable",
)


def denv(home: Path, **extra: str) -> dict[str, str]:
    return env_for(home, **{"CLAUDE_GUARD_BASH_HOOKS_DIR": str(HOOKS), **extra})


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
    out = pre_tool_use(payload("rm -rf /"), denv(home, CLAUDE_GUARD_DENY_SHADOW="0"))
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_live_mode_prints_nothing_for_a_benign_command(tmp_path):
    home = home_with(tmp_path)
    assert pre_tool_use(payload("ls -la"), denv(home, CLAUDE_GUARD_DENY_SHADOW="0")) is None


def test_live_mode_prints_the_upgrade_for_a_feature_branch_force_push(tmp_path):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_DENY_SHADOW="0")
    out = pre_tool_use(payload("git push --force origin feat"), env)
    assert json.loads(out)["hookSpecificOutput"]["updatedInput"]["command"].endswith(
        "--force-with-lease origin feat"
    )


def test_live_mode_prints_nothing_for_unparseable_stdin(tmp_path):
    # :22-23: jq yields an empty command and the bash exits 0 with no decision.
    home = home_with(tmp_path)
    assert pre_tool_use("not json", denv(home, CLAUDE_GUARD_DENY_SHADOW="0")) is None


def test_live_mode_turns_an_exception_into_ask(tmp_path, monkeypatch):
    # The deny side fails CLOSED to ask (spec, Failure contracts). A crash must never read as
    # "nothing to worry about here".
    def boom(command, cwd="", env=None):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(hook, "deny", boom)
    home = home_with(tmp_path)
    assert pre_tool_use(payload("ls"), denv(home, CLAUDE_GUARD_DENY_SHADOW="0")) == ASK_JSON


# --- the env contract ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["1", "true", "yes", "01", " 0", "", None])
def test_deny_shadow_unless_exactly_zero(tmp_path, value):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    if value is not None:
        env["CLAUDE_GUARD_DENY_SHADOW"] = value
    assert pre_tool_use(payload("rm -rf /"), env) is None
    assert (tmp_path / "logs" / DENY_LOG_NAME).exists()


def test_the_allow_side_variable_does_not_govern_the_deny_side(tmp_path):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_SHADOW="0", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    assert pre_tool_use(payload("rm -rf /"), env) is None


# --- shadow mode ---------------------------------------------------------------------------------


@skip_no_deny_bash
def test_shadow_logs_one_hashed_line_and_prints_nothing(tmp_path):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_DENY_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    assert pre_tool_use(payload("rm -rf /"), env) is None
    lines = (tmp_path / "logs" / DENY_LOG_NAME).read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert set(rec) == {"ts", "cmd_sha", "python", "bash", "rule", "detail_match"}
    assert (rec["python"], rec["bash"], rec["rule"]) == ("deny", "deny", "rm-root")
    assert rec["detail_match"] is True
    assert re.fullmatch(r"[0-9a-f]{16}", rec["cmd_sha"])
    assert "rm -rf" not in lines[0]
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", rec["ts"])


@skip_no_deny_bash
def test_shadow_records_agreement_on_a_benign_command(tmp_path):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_DENY_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    pre_tool_use(payload("ls -la"), env)
    rec = json.loads((tmp_path / "logs" / DENY_LOG_NAME).read_text())
    assert (rec["python"], rec["bash"], rec["rule"]) == ("none", "none", "")


@skip_no_deny_bash
def test_shadow_records_the_upgrade_as_allow_on_both_sides(tmp_path):
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_DENY_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    pre_tool_use(payload("git push --force origin feat"), env)
    rec = json.loads((tmp_path / "logs" / DENY_LOG_NAME).read_text())
    assert (rec["python"], rec["bash"]) == ("allow", "allow")


@skip_no_deny_bash
def test_shadow_records_a_python_error_rather_than_vanishing(tmp_path, monkeypatch):
    def boom(command, cwd="", env=None):
        raise RuntimeError("synthetic rm -rf /")

    monkeypatch.setattr(hook, "deny", boom)
    home = home_with(tmp_path)
    env = denv(home, CLAUDE_GUARD_DENY_SHADOW="1", CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    assert pre_tool_use(payload("rm -rf /"), env) is None
    line = (tmp_path / "logs" / DENY_LOG_NAME).read_text()
    rec = json.loads(line)
    assert (rec["python"], rec["bash"], rec["rule"]) == ("error", "deny", "exception")
    assert "synthetic" not in line


def test_shadow_records_bash_error_when_the_hook_is_missing(tmp_path):
    # A missing hook is NOT agreement: "error", never "none".
    home = home_with(tmp_path)
    env = denv(
        home,
        CLAUDE_GUARD_DENY_SHADOW="1",
        CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"),
        CLAUDE_GUARD_BASH_HOOKS_DIR=str(tmp_path / "nohooks"),
    )
    pre_tool_use(payload("rm -rf /"), env)
    rec = json.loads((tmp_path / "logs" / DENY_LOG_NAME).read_text())
    assert (rec["python"], rec["bash"]) == ("deny", "error")


def test_shadow_sample_governs_logging_only(tmp_path):
    home = home_with(tmp_path)
    logs = str(tmp_path / "logs")

    def sampled(roll: str) -> dict[str, str]:
        return denv(
            home,
            CLAUDE_GUARD_DENY_SHADOW="1",
            CLAUDE_SHADOW_LOG_DIR=logs,
            CLAUDE_GUARD_DENY_SHADOW_SAMPLE="10",
            CLAUDE_GUARD_DENY_SHADOW_ROLL=roll,
        )

    assert pre_tool_use(payload("rm -rf /"), sampled("3")) is None
    assert not (tmp_path / "logs" / DENY_LOG_NAME).exists()
    assert pre_tool_use(payload("rm -rf /"), sampled("0")) is None
    assert (tmp_path / "logs" / DENY_LOG_NAME).exists()


@skip_no_deny_bash
def test_shadow_does_not_write_the_cmdparse_census(tmp_path):
    # The re-run of the bash in shadow must not double-count the M02 census: the deployed
    # env carries CMDPARSE_SHADOW_SAMPLE=10, and the real hook run already logs it.
    home = home_with(tmp_path)
    env = denv(
        home,
        CLAUDE_GUARD_DENY_SHADOW="1",
        CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"),
        CMDPARSE_SHADOW="1",
        CMDPARSE_SHADOW_SAMPLE="1",
    )
    pre_tool_use(payload("ls"), env)
    assert not (tmp_path / "logs" / "cmdparse-shadow.jsonl").exists()


@skip_no_deny_bash
def test_bash_deny_verdict_reads_the_deployed_hook_directly():
    env = {"HOME": "/home/tester", "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    assert bash_deny_verdict(DENY_HOOK_SRC, payload("rm -rf /"), env)[0] == "deny"
    assert bash_deny_verdict(DENY_HOOK_SRC, payload("ls"), env) == ("none", "")


def test_bash_deny_verdict_missing_hook_is_error_not_none(tmp_path):
    env = {"HOME": str(tmp_path), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    assert bash_deny_verdict(tmp_path / "nope.sh", payload("ls"), env) == ("error", "")


def test_bash_deny_verdict_timeout_is_its_own_kind_not_error(tmp_path):
    # The bash segmenter is quadratic on large heredocs (measured 49s on 100KB), so a real
    # heredoc write can time out here. That must read as "timeout", never as "error" — the
    # shadow gate's zero-bash_error floor would otherwise block on exactly this case.
    slow = tmp_path / "slow.sh"
    slow.write_text("#!/usr/bin/env bash\nsleep 5\n")
    slow.chmod(0o755)
    env = {"HOME": str(tmp_path), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    assert bash_deny_verdict(slow, payload("ls"), env, timeout=0.2) == ("timeout", "")


# --- detail_match: same kind, different reason is not agreement (I-1) --------------------------


def test_deny_shadow_record_detail_match_true_when_reasons_agree():
    verdict = Verdict("deny", "rm-root", "Blocked: rm -rf /")
    rec = deny_shadow_record("rm -rf /", verdict, "deny", "Blocked: rm -rf /")
    assert rec["detail_match"] is True


def test_deny_shadow_record_detail_match_false_when_reasons_differ():
    verdict = Verdict("deny", "rm-root", "Blocked: root delete")
    rec = deny_shadow_record("rm -rf /", verdict, "deny", "Blocked: a different rule fired")
    assert rec["detail_match"] is False


def test_deny_shadow_record_carries_no_reason_text_only_the_boolean():
    sentinel = "SENTINELCREDENTIALPATH"
    verdict = Verdict("deny", "rm-root", f"Blocked: {sentinel}")
    rec = deny_shadow_record("rm -rf /", verdict, "deny", f"Blocked: {sentinel}")
    line = json.dumps(rec)
    assert sentinel not in line
    assert rec["detail_match"] is True


# --- the shadow-report buckets, with a red-proof ----------------------------------------------


def _rec(py: str, sh: str, rule: str = "", detail_match: bool | None = None) -> str:
    rec = {"ts": "t", "cmd_sha": "0" * 16, "python": py, "bash": sh, "rule": rule}
    if detail_match is not None:
        rec["detail_match"] = detail_match
    return json.dumps(rec)


def test_summarize_deny_buckets_every_combination():
    s = summarize_deny(
        [
            _rec("deny", "deny", "rm-root"),
            _rec("ask", "ask", "exception"),
            _rec("none", "none"),
            _rec("allow", "allow", "force-push-upgrade"),
            _rec("deny", "none", "pkill"),
            _rec("none", "deny"),
            _rec("deny", "allow", "push-main"),
            _rec("error", "deny", "exception"),
            _rec("deny", "error", "rm-root"),
            "not json",
            "",
        ]
    )
    assert s["records"] == 9 and s["unparseable"] == 1
    assert (s["agree_deny"], s["agree_ask"], s["agree_none"], s["agree_allow"]) == (
        1,
        1,
        1,
        1,
    )
    assert (s["python_only"], s["bash_only"], s["mismatch"]) == (1, 1, 1)
    assert (s["python_error"], s["bash_error"]) == (1, 1)
    assert s["python_only_rules"] == {"pkill": 1}
    assert s["mismatch_rules"] == {"push-main": 1}


def test_summarize_deny_an_empty_log_is_zero_records_not_agreement():
    s = summarize_deny([])
    assert s["records"] == 0 and s["agree"] == 0


def test_summarize_deny_same_kind_same_detail_is_agreement():
    s = summarize_deny([_rec("deny", "deny", "rm-root", detail_match=True)])
    assert (s["agree_deny"], s["detail_mismatch"]) == (1, 0)


def test_summarize_deny_same_kind_different_detail_is_detail_mismatch_not_agreement():
    # Two sides that both `deny` for DIFFERENT rules (different messages) must not read as
    # agree_deny: detail_match=False on an agree-kind record moves it to its own bucket.
    s = summarize_deny([_rec("deny", "deny", "rm-root", detail_match=False)])
    assert (s["agree_deny"], s["detail_mismatch"], s["records"]) == (0, 1, 1)


def test_summarize_deny_bash_timeout_is_its_own_bucket_never_agree_or_python_only():
    # A timed-out bash re-run must never read as agreement (it didn't decide) or as
    # python_only (bash wasn't silent, it timed out).
    s = summarize_deny([_rec("deny", "timeout", "rm-root")])
    assert s["bash_timeout"] == 1
    assert (s["agree"], s["python_only"], s["bash_only"], s["mismatch"]) == (0, 0, 0, 0)


def test_summarize_deny_unrecognised_kind_is_unparseable_not_agree_none():
    s = summarize_deny([_rec("bogus", "bogus", "whatever")])
    assert (s["unparseable"], s["records"], s["agree_none"]) == (1, 0, 0)


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
def test_deny_shim_prints_the_deny_line_when_told_to_run_live(tmp_path):
    home = home_with(tmp_path)
    r = run_deny_shim(payload("rm -rf /"), shim_env(home, CLAUDE_GUARD_DENY_SHADOW="0"))
    assert r.returncode == 0, r.stderr
    assert decision(r.stdout) == "deny"


@skip_no_uv
def test_deny_shim_prints_nothing_live_for_a_benign_command(tmp_path):
    home = home_with(tmp_path)
    r = run_deny_shim(payload("ls -la"), shim_env(home, CLAUDE_GUARD_DENY_SHADOW="0"))
    assert (r.returncode, r.stdout) == (0, "")


@skip_no_uv
def test_deny_shim_defaults_to_shadow_and_logs(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_SHADOW_LOG_DIR=str(tmp_path / "logs"))
    r = run_deny_shim(payload("rm -rf /"), env)
    assert (r.returncode, r.stdout) == (0, "")
    rec = json.loads((tmp_path / "logs" / DENY_LOG_NAME).read_text())
    assert rec["python"] == "deny"


def test_deny_shim_asks_without_an_interpreter_when_live(tmp_path):
    # Spec, Failure contracts, claude-guard deny path: the shim emits ask ITSELF, without
    # Python. PATH has no uv and no python; only bash builtins run.
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_DENY_SHADOW="0", PATH="/nonexistent")
    r = run_deny_shim(payload("rm -rf /"), env)
    assert r.returncode == 0
    assert decision(r.stdout) == "ask"


def test_deny_shim_asks_when_the_package_is_missing_when_live(tmp_path):
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_DENY_SHADOW="0", CLAUDE_GUARD_HOME=str(tmp_path / "nowhere"))
    r = run_deny_shim(payload("rm -rf /"), env)
    assert (r.returncode, decision(r.stdout)) == (0, "ask")


@skip_no_uv
def test_deny_shim_asks_when_python_exits_non_zero_when_live(tmp_path):
    # A package whose cli.py dies before the hook's own try/except: the shim, not Python,
    # owns the ask. Built as a real package so the shim's own `-f cli.py` check passes.
    fake = tmp_path / "fake" / "claude_guard"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text("")
    (fake / "cli.py").write_text("import sys\nsys.exit(3)\n")
    home = home_with(tmp_path)
    env = shim_env(home, CLAUDE_GUARD_DENY_SHADOW="0", CLAUDE_GUARD_HOME=str(tmp_path / "fake"))
    r = run_deny_shim(payload("rm -rf /"), env)
    assert (r.returncode, decision(r.stdout)) == (0, "ask")


def test_deny_shim_is_silent_on_every_failure_in_shadow(tmp_path):
    home = home_with(tmp_path)
    for env in (
        shim_env(home, PATH="/nonexistent"),
        shim_env(home, CLAUDE_GUARD_HOME=str(tmp_path / "nowhere")),
        shim_env(home, CLAUDE_GUARD_DENY_SHADOW="1", PATH="/nonexistent"),
    ):
        r = run_deny_shim(payload("rm -rf /"), env)
        assert (r.returncode, r.stdout) == (0, "")
