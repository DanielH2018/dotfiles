"""The claude-guard hook entry points: stdin JSON in, a decision line or nothing out.

This module owns both hook entries: permission_request() (the allow path, PermissionRequest;
emits nothing on failure) and pre_tool_use() (the deny path, PreToolUse; emits ask on
failure), each with its own shadow variable and its own shadow log.

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

from claude_guard.deny import Verdict, deny
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


def shadow_mode(env: Mapping[str, str], var: str = "CLAUDE_GUARD_SHADOW") -> tuple[bool, bool]:
    """(shadow, log_this_call) for the variable `var` and its `_SAMPLE` / `_ROLL` companions.

    Shadow unless the variable is exactly "0" — fail-safe: absent, misspelled, or any
    other truthy-looking value ("true", "yes", "01", " 1") all stay in shadow. The
    PermissionRequest side reads CLAUDE_GUARD_SHADOW; the PreToolUse side reads
    CLAUDE_GUARD_DENY_SHADOW, so the two cut over independently (spec, Rollout rows 3 and 4).
    """
    if env.get(var, "1") == "0":
        return False, False
    sample = env.get(f"{var}_SAMPLE", "")
    if not (sample.isdigit() and int(sample) > 0):
        return True, True
    roll = env.get(f"{var}_ROLL", "")
    draw = int(roll) if roll.isdigit() else random.randrange(int(sample))
    return True, draw == 0


def resolve_hook(hooks_dir: Path, name: str) -> Path | None:
    """Deployed name first, then the chezmoi source name, as allow-compound-bash.sh:115-116."""
    for candidate in (hooks_dir / name, hooks_dir / f"executable_{name}"):
        if candidate.is_file():
            return candidate
    return None


def _bash_env(hooks_dir: Path, env: Mapping[str, str], drop_census: bool = False) -> dict[str, str]:
    """The bash hooks' env: the two sourced libraries resolved by their source-tree names when
    the deployed names are absent (allow-compound-bash.sh:115-116). `drop_census` removes the
    M02 census switches so a shadow RE-RUN of block-dangerous-bash.sh does not write a second
    cmdparse-shadow.jsonl row for a call the real hook run already censused."""
    child_env = dict(env)
    for lib, var in (("cmdparse.sh", "CMDPARSE_LIB"), ("hook-input.sh", "HOOK_INPUT_LIB")):
        found = resolve_hook(hooks_dir, lib)
        if found is not None:
            child_env.setdefault(var, str(found))
    if drop_census:
        child_env.pop("CMDPARSE_SHADOW", None)
        child_env.pop("CMDPARSE_SHADOW_SAMPLE", None)
    return child_env


def bash_chain_allows(hooks_dir: Path, stdin_text: str, env: Mapping[str, str]) -> str | None:
    child_env = _bash_env(hooks_dir, env)
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


def append_log(log_dir: Path, record: dict, name: str = LOG_NAME) -> None:
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / name).open("a", encoding="utf-8") as f:
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


# =============================================================================================
# PreToolUse: the deny rules (block-dangerous-bash.sh), with their own shadow
# =============================================================================================

DENY_LOG_NAME = "claude-guard-deny-shadow.jsonl"
DENY_HOOK = "block-dangerous-bash.sh"
# The harness registers the bash hook at 10 s (settings.base.json, PreToolUse). Half of that
# for the shadow re-run, so a stalled bash cannot push THIS hook past its own 10 s.
_DENY_HOOK_TIMEOUT = 5.0
ASK_REASON = (
    "claude-guard: the dangerous-command rules could not be evaluated. "
    "Review this command yourself."
)


def pre_tool_use_json(v: Verdict) -> str | None:
    """The PreToolUse stdout the bash prints: deny (:601-611), ask (hook-input.sh:83, :69),
    allow with updatedInput and additionalContext (:1133-1140). None for no decision."""
    if v.kind == "none":
        return None
    out: dict = {"hookEventName": "PreToolUse", "permissionDecision": v.kind}
    if v.kind == "allow":
        out["updatedInput"] = {"command": v.updated_command}
        out["additionalContext"] = v.context
    else:
        out["permissionDecisionReason"] = v.reason
    return json.dumps({"hookSpecificOutput": out})


ASK_JSON = pre_tool_use_json(Verdict("ask", "exception", ASK_REASON))


def bash_deny_verdict(hook_path: Path, stdin_text: str, env: Mapping[str, str]) -> tuple[str, str]:
    """(permissionDecision, detail) from the bash hook at `hook_path`: ("none", "") when it
    prints nothing, ("error", "") when it cannot be run or its output cannot be read — never
    "none" for those, so a missing or hung hook does not read as agreement. `detail` is the
    reason for deny/ask and the updated command for allow."""
    if not hook_path.is_file():
        return ("error", "")
    child_env = _bash_env(hook_path.parent, env, drop_census=True)
    try:
        r = subprocess.run(
            ["bash", str(hook_path)],
            input=stdin_text,
            capture_output=True,
            text=True,
            env=child_env,
            timeout=_DENY_HOOK_TIMEOUT,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return ("error", "")
    if not r.stdout.strip():
        return ("none", "")
    try:
        out = json.loads(r.stdout)["hookSpecificOutput"]
        kind = str(out["permissionDecision"])
        if kind == "allow":
            return (kind, str(out["updatedInput"]["command"]))
        return (kind, str(out.get("permissionDecisionReason", "")))
    except (ValueError, KeyError, TypeError):
        return ("error", "")


def deny_shadow_record(command: str, verdict: Verdict | None, bash_kind: str) -> dict:
    """`verdict` None means the decision step raised: python "error", rule "exception" —
    never the exception text, which can quote the command the log exists to avoid."""
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cmd_sha": command_sha(command),
        "python": verdict.kind if verdict is not None else "error",
        "bash": bash_kind,
        "rule": verdict.rule if verdict is not None else "exception",
    }


def pre_tool_use(
    stdin_text: str,
    env: Mapping[str, str],
    hooks_dir: Path | None = None,
    log_dir: Path | None = None,
    hook_path: Path | None = None,
) -> str | None:
    """Live: the deny/ask/allow JSON or None. Shadow: None, after one log line.

    Never raises. In LIVE mode an exception becomes ASK_JSON: the deny side fails closed to
    ask (spec, Failure contracts), matching the bash on a missing jq. In shadow it becomes a
    python:"error" record. Unparseable stdin is no decision in both modes (:22-23)."""
    try:
        command = read_command(stdin_text)
    except Exception:
        command = None
    if command is None:
        return None
    shadow, log_this = shadow_mode(env, "CLAUDE_GUARD_DENY_SHADOW")
    if not shadow:
        try:
            return pre_tool_use_json(deny(command, "", env))
        except Exception:
            return ASK_JSON
    try:
        verdict: Verdict | None = deny(command, "", env)
    except Exception:
        verdict = None
    if log_this:
        try:
            home = Path(env.get("HOME", ""))
            hooks = hooks_dir or Path(
                env.get("CLAUDE_GUARD_BASH_HOOKS_DIR") or home / ".claude" / "hooks"
            )
            logs = log_dir or Path(env.get("CLAUDE_SHADOW_LOG_DIR") or home / ".claude" / "logs")
            path = hook_path or resolve_hook(hooks, DENY_HOOK) or hooks / DENY_HOOK
            bash_kind, _detail = bash_deny_verdict(path, stdin_text, env)
            append_log(logs, deny_shadow_record(command, verdict, bash_kind), DENY_LOG_NAME)
        except Exception:
            return None
    return None


def summarize_deny(lines: Iterable[str]) -> dict:
    """Counts only. agree_* per kind; python_only (python decided, bash silent); bash_only
    (the reverse); mismatch (both decided, differently — deny vs allow is the live case);
    python_error and bash_error are their own buckets, never folded into a disagreement,
    because that side did not answer."""
    records = unparseable = 0
    agree = {"deny": 0, "ask": 0, "none": 0, "allow": 0}
    python_only = bash_only = mismatch = python_error = bash_error = 0
    python_only_rules: Counter[str] = Counter()
    bash_only_rules: Counter[str] = Counter()
    mismatch_rules: Counter[str] = Counter()
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
        py, sh, rule = rec["python"], rec["bash"], str(rec.get("rule", ""))
        if py == "error":
            python_error += 1
        elif sh == "error":
            bash_error += 1
        elif py == sh:
            agree[py if py in agree else "none"] += 1
        elif sh == "none":
            python_only += 1
            python_only_rules[rule] += 1
        elif py == "none":
            bash_only += 1
            bash_only_rules[rule] += 1
        else:
            mismatch += 1
            mismatch_rules[rule] += 1
    return {
        "records": records,
        "unparseable": unparseable,
        "agree": sum(agree.values()),
        "agree_deny": agree["deny"],
        "agree_ask": agree["ask"],
        "agree_none": agree["none"],
        "agree_allow": agree["allow"],
        "python_only": python_only,
        "bash_only": bash_only,
        "mismatch": mismatch,
        "python_error": python_error,
        "bash_error": bash_error,
        "python_only_rules": dict(python_only_rules),
        "bash_only_rules": dict(bash_only_rules),
        "mismatch_rules": dict(mismatch_rules),
    }
