"""The PermissionRequest hook: stdin JSON in, one allow line or nothing out.

Failure contract (spec, *Failure contracts*, allow path): cannot run or cannot parse → emit
nothing, so the prompt stands. permission_request() therefore never raises.

Shadow mode (spec, *Rollout* row 2): the hook runs in shadow unless CLAUDE_GUARD_SHADOW is
exactly "0". In shadow the judge's verdict is computed, the deployed bash chain is run on
the same stdin the way the harness would (any allow wins), one JSON line is appended to the
shadow log, and NOTHING is printed. The log carries a hash of the command, never the
command. `claude-guard shadow-report` reads it. Shadow is the fail-safe default: an unset,
misspelled, or truthy-but-not-"0" value ("true", "yes", "01") all stay in shadow, so a typo
in an env override can only suppress a live decision, never cause one.

Sampling: within shadow, CLAUDE_GUARD_SHADOW_SAMPLE=N logs 1 in N calls, chosen fresh each
call; CLAUDE_GUARD_SHADOW_ROLL is a TEST SEAM ONLY — it overrides the random draw so a test
can pin which branch runs, and has no reason to be set outside a test. Same idiom as the M02
census in block-dangerous-bash.sh:423-435, except that here sampling governs LOGGING only: a
sampled miss still decides nothing, because deciding is what shadow suppresses.
"""

import hashlib
import json
import random
import subprocess
import time
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path

from claude_guard.judge import Decision, judge
from claude_guard.rules import load_rules
from claude_guard.tables import scratch_roots

ALLOW_JSON = (
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
)
# The deployed hooks this one shadows, in registration order (settings.base.json,
# PermissionRequest). allow-readonly-remote.sh and allow-daniel-server.sh are not ported in
# this slice and are not compared.
BASH_CHAIN = ("allow-compound-bash.sh", "allow-safe-curl.sh", "allow-safe-rm.sh")
LOG_NAME = "claude-guard-shadow.jsonl"
_HOOK_TIMEOUT = 3.0


def read_command(stdin_text: str) -> str | None:
    try:
        data = json.loads(stdin_text)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    command = tool_input.get("command")
    return command if isinstance(command, str) else None


def decide(command: str, env: Mapping[str, str]) -> Decision:
    rules = load_rules(env=env)
    roots = scratch_roots(env.get("HOME", ""), env.get("TMPDIR"))
    return judge(command, rules, roots)


def shadow_mode(env: Mapping[str, str]) -> tuple[bool, bool]:
    """(shadow, log_this_call).

    Shadow unless the variable is exactly "0" — fail-safe: absent, misspelled, or any
    other truthy-looking value ("true", "yes", "01", " 1") all stay in shadow.
    """
    if env.get("CLAUDE_GUARD_SHADOW", "1") == "0":
        return False, False
    sample = env.get("CLAUDE_GUARD_SHADOW_SAMPLE", "")
    if not (sample.isdigit() and int(sample) > 0):
        return True, True
    roll = env.get("CLAUDE_GUARD_SHADOW_ROLL", "")
    draw = int(roll) if roll.isdigit() else random.randrange(int(sample))
    return True, draw == 0


def resolve_hook(hooks_dir: Path, name: str) -> Path | None:
    """Deployed name first, then the chezmoi source name, as allow-compound-bash.sh:115-116."""
    for candidate in (hooks_dir / name, hooks_dir / f"executable_{name}"):
        if candidate.is_file():
            return candidate
    return None


def bash_chain_allows(hooks_dir: Path, stdin_text: str, env: Mapping[str, str]) -> str | None:
    child_env = dict(env)
    for lib, var in (("cmdparse.sh", "CMDPARSE_LIB"), ("hook-input.sh", "HOOK_INPUT_LIB")):
        found = resolve_hook(hooks_dir, lib)
        if found is not None:
            child_env.setdefault(var, str(found))
    for name in BASH_CHAIN:
        path = resolve_hook(hooks_dir, name)
        if path is None:
            continue
        try:
            r = subprocess.run(
                ["bash", str(path)],
                input=stdin_text,
                capture_output=True,
                text=True,
                env=child_env,
                timeout=_HOOK_TIMEOUT,
                check=False,
            )
        except OSError, subprocess.TimeoutExpired:
            continue
        if '"allow"' in r.stdout:
            return name
    return None


def command_sha(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def shadow_record(command: str, decision: Decision, bash_hook: str | None) -> dict:
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cmd_sha": command_sha(command),
        "python": "allow" if decision.allow else "none",
        "bash": "allow" if bash_hook else "none",
        "rule": decision.rule,
        "bash_hook": bash_hook,
    }


def shadow_error_record(command: str, bash_hook: str | None) -> dict:
    """A record for when the decision step itself raised.

    `rule` is the fixed literal "exception", never the exception text — the log carries a
    hash of the command and nothing else identifying, and an exception message can quote
    the very command text the log exists to avoid recording.
    """
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cmd_sha": command_sha(command),
        "python": "error",
        "bash": "allow" if bash_hook else "none",
        "rule": "exception",
        "bash_hook": bash_hook,
    }


def append_log(log_dir: Path, record: dict) -> None:
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / LOG_NAME).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        return


def permission_request(
    stdin_text: str,
    env: Mapping[str, str],
    hooks_dir: Path | None = None,
    log_dir: Path | None = None,
) -> str | None:
    try:
        command = read_command(stdin_text)
        if command is None:
            return None
        shadow, log_this = shadow_mode(env)
        if not shadow:
            decision = decide(command, env)
            return ALLOW_JSON if decision.allow else None
        # Shadow: the decision step is caught on its own, separately from everything
        # around it, so an exception in judge()/load_rules() still leaves a record
        # instead of silently vanishing the way the live-mode contract requires.
        try:
            decision: Decision | None = decide(command, env)
        except Exception:
            decision = None
        if log_this:
            home = Path(env.get("HOME", ""))
            hooks = hooks_dir or Path(
                env.get("CLAUDE_GUARD_BASH_HOOKS_DIR") or home / ".claude" / "hooks"
            )
            logs = log_dir or Path(env.get("CLAUDE_SHADOW_LOG_DIR") or home / ".claude" / "logs")
            bash_hook = bash_chain_allows(hooks, stdin_text, env)
            record = (
                shadow_error_record(command, bash_hook)
                if decision is None
                else shadow_record(command, decision, bash_hook)
            )
            append_log(logs, record)
        return None
    except Exception:
        return None


def summarize(lines: Iterable[str]) -> dict:
    """Counts only: agree / python-only / bash-only / python-error and the rules behind
    each disagreement. A `python_error` row (rule "exception") is its own bucket, never
    folded into bash-only — the python side didn't disagree, it didn't answer."""
    records = 0
    unparseable = 0
    agree_allow = agree_none = python_only = bash_only = python_error = 0
    python_only_rules: Counter[str] = Counter()
    bash_only_rules: Counter[str] = Counter()
    for line in lines:
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            unparseable += 1
            continue
        if not isinstance(rec, dict) or "python" not in rec or "bash" not in rec:
            unparseable += 1
            continue
        records += 1
        py, sh = rec.get("python"), rec.get("bash")
        if py == "error":
            python_error += 1
        elif py == sh:
            if py == "allow":
                agree_allow += 1
            else:
                agree_none += 1
        elif py == "allow":
            python_only += 1
            python_only_rules[str(rec.get("rule"))] += 1
        else:
            bash_only += 1
            bash_only_rules[f"{rec.get('rule')} ({rec.get('bash_hook')})"] += 1
    return {
        "records": records,
        "unparseable": unparseable,
        "agree": agree_allow + agree_none,
        "agree_allow": agree_allow,
        "agree_none": agree_none,
        "python_only": python_only,
        "bash_only": bash_only,
        "python_error": python_error,
        "python_only_rules": dict(python_only_rules),
        "bash_only_rules": dict(bash_only_rules),
    }
