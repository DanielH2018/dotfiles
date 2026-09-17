"""The claude-guard hook entry points: stdin JSON in, a decision line or nothing out.

This module owns both hook entries: permission_request() (the allow path, PermissionRequest;
emits nothing on failure, always live) and pre_tool_use() (the deny path, PreToolUse; emits
ask on failure, with its own shadow mode and its own shadow log).

Failure contract (spec, *Failure contracts*, allow path): cannot run or cannot parse → emit
nothing, so the prompt stands. permission_request() therefore never raises.

The allow side has no shadow mode. Slice 2 shipped it in shadow against a six-member bash
chain (`BASH_CHAIN`); slice 3 cut it over to live and deleted all six chain members; slice 6
(2026-09-17) retired the shadow apparatus itself (`CLAUDE_GUARD_SHADOW`, `BASH_CHAIN`,
`bash_chain_allows`, `shadow_record`, `summarize`, `claude-guard-shadow.jsonl`) because by
then it had been comparing against files that did not exist on disk since slice 3 — every
BASH_CHAIN member was already gone, so shadow mode could compute a verdict but never a real
agreement. permission_request() is now live-only; see `pre_tool_use()` below for the deny
side's own shadow mode, which stays live because `block-dangerous-bash.sh` — the hook it
shadows — stays deployed for the sandbox.
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


def read_cwd(stdin_text: str) -> str:
    """The session's cwd (the hook JSON's top-level `.cwd`), or "" when absent or the
    payload doesn't parse.

    Fix round 1, F1: "" is NOT judge()'s own fall-through for a real path — `git -C ""`
    is a documented no-op that silently probes the hook PROCESS's own cwd, which is
    exactly the fail-open this correction closes. clean_reset_safe and
    _under_session_cwd now refuse outright on a falsy cwd, so "" reaching them from here
    reads as "no opinion", never as the process's own directory standing in for the
    session's.
    """
    try:
        data = json.loads(stdin_text)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    cwd = data.get("cwd")
    return cwd if isinstance(cwd, str) else ""


def decide(command: str, cwd: str, env: Mapping[str, str]) -> Decision:
    rules = load_rules(env=env)
    roots = scratch_roots(env.get("HOME", ""), env.get("TMPDIR"))
    return judge(command, rules, roots, cwd)


def shadow_mode(env: Mapping[str, str], var: str) -> tuple[bool, bool]:
    """(shadow, log_this_call) for the variable `var` and its `_SAMPLE` / `_ROLL` companions.

    Shadow unless the variable is exactly "0" — fail-safe: absent, misspelled, or any
    other truthy-looking value ("true", "yes", "01", " 1") all stay in shadow. The only
    caller left is the PreToolUse side, with CLAUDE_GUARD_DENY_SHADOW (spec, Rollout row 4);
    the PermissionRequest side had its own CLAUDE_GUARD_SHADOW switch until slice 6 retired
    it (module docstring above).
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


def command_sha(command: str) -> str:
    return hashlib.sha256(command.encode("utf-8", "surrogateescape")).hexdigest()[:16]


def append_log(log_dir: Path, record: dict, name: str) -> None:
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with (log_dir / name).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        return


def permission_request(stdin_text: str, env: Mapping[str, str]) -> str | None:
    """Live only (module docstring above): allow JSON on an allow verdict, nothing otherwise."""
    try:
        command = read_command(stdin_text)
        if command is None:
            return None
        cwd = read_cwd(stdin_text)
        decision = decide(command, cwd, env)
        return ALLOW_JSON if decision.allow else None
    except Exception:
        return None


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


def bash_deny_verdict(
    hook_path: Path,
    stdin_text: str,
    env: Mapping[str, str],
    timeout: float = _DENY_HOOK_TIMEOUT,
) -> tuple[str, str]:
    """(permissionDecision, detail) from the bash hook at `hook_path`: ("none", "") when it
    prints nothing, ("error", "") when it cannot be run or its output cannot be read, ("timeout",
    "") when it ran past `timeout` — never "none" for those, so a missing, broken or hung hook
    does not read as agreement. Timeout is its own kind, not folded into "error": the bash
    segmenter is quadratic on large heredocs (measured 49s on 100KB, well past this hook's own
    5s re-run cap), so a real heredoc write times out here on every call, and the shadow gate
    must not read that as a python/bash disagreement (summarize_deny's bash_timeout bucket).
    `detail` is the reason for deny/ask and the updated command for allow."""
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
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ("timeout", "")
    except OSError:
        return ("error", "")
    if not r.stdout.strip():
        return ("none", "")
    try:
        out = json.loads(r.stdout)["hookSpecificOutput"]
        kind = str(out["permissionDecision"])
        if kind == "allow":
            return (kind, str(out["updatedInput"]["command"]))
        return (kind, str(out.get("permissionDecisionReason", "")))
    except ValueError, KeyError, TypeError:
        return ("error", "")


def deny_shadow_record(
    command: str, verdict: Verdict | None, bash_kind: str, bash_detail: str = ""
) -> dict:
    """`verdict` None means the decision step raised: python "error", rule "exception" —
    never the exception text, which can quote the command the log exists to avoid.

    `detail_match` compares the python side's detail (the updated command for an allow
    verdict, else the reason) against the bash's `bash_detail` from `bash_deny_verdict`.
    Only the boolean enters the record — never the command or reason text, which the log
    exists to avoid recording. It exists so two sides that both `deny` for DIFFERENT rules
    (different messages) don't read as `agree_deny`; `summarize_deny` moves an agree-kind
    record with `detail_match is False` into its own `detail_mismatch` bucket."""
    python_detail = None
    if verdict is not None:
        python_detail = verdict.updated_command if verdict.kind == "allow" else verdict.reason
    return {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cmd_sha": command_sha(command),
        "python": verdict.kind if verdict is not None else "error",
        "bash": bash_kind,
        "rule": verdict.rule if verdict is not None else "exception",
        "detail_match": python_detail is not None and python_detail == bash_detail,
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
            bash_kind, bash_detail = bash_deny_verdict(path, stdin_text, env)
            record = deny_shadow_record(command, verdict, bash_kind, bash_detail)
            append_log(logs, record, DENY_LOG_NAME)
        except Exception:
            return None
    return None


_DENY_PYTHON_KINDS = frozenset({"deny", "ask", "allow", "none", "error"})
_DENY_BASH_KINDS = frozenset({"deny", "ask", "allow", "none", "error", "timeout"})


def summarize_deny(lines: Iterable[str]) -> dict:
    """Counts only. agree_* per kind; python_only (python decided, bash silent); bash_only
    (the reverse); mismatch (both decided, differently — deny vs allow is the live case);
    python_error and bash_error are their own buckets, never folded into a disagreement,
    because that side did not answer. bash_timeout is checked before both the agree and the
    python_only branches, so a timed-out bash re-run (the segmenter is quadratic on large
    heredocs, past this hook's own 5s re-run cap) can never read as agreement or as a python
    decision the bash silently missed. detail_mismatch catches an agree-kind record (both
    sides `deny`, say) whose `detail_match` is False: the two decided the SAME kind for
    DIFFERENT reasons, which is not agreement. An unrecognised kind on either side is
    unparseable, not a silent `agree_none`."""
    records = unparseable = 0
    agree = {"deny": 0, "ask": 0, "none": 0, "allow": 0}
    python_only = bash_only = mismatch = python_error = bash_error = bash_timeout = 0
    detail_mismatch = 0
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
        py, sh, rule = rec["python"], rec["bash"], str(rec.get("rule", ""))
        if py not in _DENY_PYTHON_KINDS or sh not in _DENY_BASH_KINDS:
            unparseable += 1
            continue
        records += 1
        if py == "error":
            python_error += 1
        elif sh == "error":
            bash_error += 1
        elif sh == "timeout":
            bash_timeout += 1
        elif py == sh:
            if rec.get("detail_match") is False:
                detail_mismatch += 1
            else:
                agree[py] += 1
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
        "detail_mismatch": detail_mismatch,
        "python_error": python_error,
        "bash_error": bash_error,
        "bash_timeout": bash_timeout,
        "python_only_rules": dict(python_only_rules),
        "bash_only_rules": dict(bash_only_rules),
        "mismatch_rules": dict(mismatch_rules),
    }
