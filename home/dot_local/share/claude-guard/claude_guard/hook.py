"""The claude-guard hook entry points: stdin JSON in, a decision line or nothing out.

This module owns both hook entries: permission_request() (the allow path, PermissionRequest;
emits nothing on failure) and pre_tool_use() (the deny path, PreToolUse; emits ask on
failure). Both are live-only.

Failure contract (spec, *Failure contracts*, allow path): cannot run or cannot parse → emit
nothing, so the prompt stands. permission_request() therefore never raises.

Neither side has a shadow mode any more. Slice 2 shipped the allow side in shadow against a
six-member bash chain (`BASH_CHAIN`); slice 3 cut it over and deleted all six; slice 6
(2026-09-17) retired that apparatus (`CLAUDE_GUARD_SHADOW`, `BASH_CHAIN`, `bash_chain_allows`,
`shadow_record`, `summarize`, `claude-guard-shadow.jsonl`) because it had been comparing
against files that no longer existed. The deny side kept its own shadow
(`CLAUDE_GUARD_DENY_SHADOW`, `bash_deny_verdict`, `deny_shadow_record`, `summarize_deny`,
`claude-guard-deny-shadow.jsonl`) for as long as `block-dangerous-bash.sh` still ran
somewhere — the sandbox, until the port in dotfiles #508 moved it onto the same shim — and
the rest of slice 6 (2026-09-18) deleted the bash hook and that apparatus together. The
agreement record both shadows produced is in the spec's Rollout table, rows 2 and 4.
"""

import json
from collections.abc import Mapping

from claude_guard.checks import git_conventions
from claude_guard.deny import Verdict, deny
from claude_guard.footguns import footgun
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
# PreToolUse: the deny rules (the block-dangerous-bash.sh port)
# =============================================================================================

ASK_REASON = (
    "claude-guard: the dangerous-command rules could not be evaluated. "
    "Review this command yourself."
)


def pre_tool_use_json(v: Verdict) -> str | None:
    """The PreToolUse stdout the bash prints: deny (:601-611), ask (hook-input.sh:83, :69),
    allow with updatedInput and additionalContext (:1133-1140). None for no decision. An ask
    carries updatedInput too when it stands in for the --force upgrade (_combine)."""
    if v.kind == "none":
        return None
    out: dict = {"hookEventName": "PreToolUse", "permissionDecision": v.kind}
    if v.kind != "allow":
        out["permissionDecisionReason"] = v.reason
    if v.updated_command is not None:
        out["updatedInput"] = {"command": v.updated_command}
        out["additionalContext"] = v.context
    return json.dumps({"hookSpecificOutput": out})


ASK_JSON = pre_tool_use_json(Verdict("ask", "exception", ASK_REASON))


def conventions(command: str, cwd: str) -> Verdict | None:
    """claude_guard.checks.git_conventions as a Verdict, or None. Never raises: a failure in
    a convention check is no decision (that module's DECIDED), not the deny side's ask."""
    try:
        v = git_conventions.verdict(command, cwd, git_conventions.read_git_config)
    except Exception:
        return None
    return Verdict(v[0], "git-conventions", v[1]) if v else None


def _combine(rules: Verdict, conv: Verdict | None) -> Verdict:
    """The deny rules' verdict and the conventions', merged the way the harness merged them
    while they were two hooks (#619): a deny from either wins, then an ask from either.

    A convention ask over the --force upgrade keeps the upgraded command, so approving the
    prompt runs --force-with-lease rather than the --force the allow would have replaced."""
    if conv is None or rules.kind == "deny":
        return rules
    if conv.kind == "deny" or rules.kind == "none":
        return conv
    if rules.kind == "allow":
        return Verdict(conv.kind, conv.rule, conv.reason, rules.updated_command, rules.context)
    return rules


def pre_tool_use(stdin_text: str, env: Mapping[str, str]) -> str | None:
    """The deny/ask/allow JSON, or None for no decision.

    Never raises. An exception in the deny rules becomes ASK_JSON: the deny side fails closed
    to ask (spec, Failure contracts), the posture the bash took on a missing jq. Unparseable
    stdin is no decision (:22-23). The git conventions run beside the deny rules and fail
    open (conventions())."""
    try:
        command = read_command(stdin_text)
    except Exception:
        command = None
    if command is None:
        return None
    try:
        rules = merge(deny(command, "", env), footgun(command))
    except Exception:
        return ASK_JSON
    return pre_tool_use_json(_combine(rules, conventions(command, read_cwd(stdin_text))))


_RANK = {"deny": 3, "ask": 2, "allow": 1, "none": 0}


def merge(danger: Verdict, slip: Verdict | None) -> Verdict:
    """One PreToolUse verdict from the deny rules and the footgun rules.

    deny beats ask beats allow, as two separate hooks' verdicts would merge in the harness.
    On a tie the deny rules win, because they ran first and carry the older message. A
    footgun deny therefore overrides the --force-with-lease upgrade's allow: the upgrade
    rewrites one push, and the other stage it would have waved through is the mistake.
    """
    if slip is None or _RANK[slip.kind] <= _RANK[danger.kind]:
        return danger
    return slip
