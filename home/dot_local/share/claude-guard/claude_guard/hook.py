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
import os
from collections.abc import Mapping

from claude_guard import (
    apply_guard,
    bypass,
    prompt_tool,
    protected_paths,
    tq_wrap,
    waits,
    wrapped,
)
from claude_guard.checks import (
    git_conventions,
    homelab_deploy,
    read_only_agents,
    worktree_escape,
)
from claude_guard.checks.awk import awk_risk
from claude_guard.deny import NONE, Verdict, deny
from claude_guard.event import PreToolUseEvent
from claude_guard.event import parse as parse_event
from claude_guard.footguns import footgun
from claude_guard.judge import Decision, judge
from claude_guard.nudges import claim, nudge, read_nudge
from claude_guard.readonly import readonly
from claude_guard.rules import load_rules
from claude_guard.segment import parse
from claude_guard.tables import scratch_roots

FILE_TOOLS = frozenset({"Edit", "Write", "NotebookEdit"})
ALLOW_JSON = (
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
)


def decide(
    command: str, cwd: str | None, env: Mapping[str, str], agent_id: str | None = None
) -> Decision:
    """The judge's decision for `command`, never an allow where the deny rules or the git
    conventions deny it.

    `cwd` is None when the payload names no session directory; the judge then refuses
    every check that needs one. `agent_id` is None for the main session.

    The PreToolUse hook denies such a command before any prompt, so this gate decides only
    when that hook could not run. The settings carry no deny rule for a command those
    checks deny, so without the gate an allow rule such as `git push:*` would approve a
    forced push here."""
    refused = combine_conventions(deny(command, cwd or "", env), conventions(command, cwd))
    if refused.kind == "deny":
        return Decision(False, f"deny-rule:{refused.rule}", ())
    rules = load_rules(env=env)
    roots = scratch_roots(env.get("HOME", ""), env.get("TMPDIR"))
    return judge(
        command,
        rules,
        roots,
        cwd or "",
        env.get("CLAUDE_PROJECT_DIR", ""),
        env.get("CLAUDE_JOB_DIR", ""),
        agent_id or "",
    )


def permission_request(stdin_text: str, env: Mapping[str, str]) -> str | None:
    """Live only (module docstring above): allow JSON on an allow verdict, nothing otherwise."""
    try:
        event = parse_event(stdin_text)
        if event is None or event.bash is None:
            return None
        decision = decide(event.bash.command, event.cwd, env, event.agent_id)
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


def pre_tool_use_json(
    v: Verdict, nudge_text: str | None = None, updated_input: dict | None = None
) -> str | None:
    """The PreToolUse stdout the bash prints: deny (:601-611), ask (hook-input.sh:83, :69),
    or allow (the read-only classifier). None for no decision. The bash's `updatedInput`
    --force upgrade was retired for a deny (dotfiles #701); the one rewrite left is a
    `cc-wait` call's (claude_guard.waits), which changes how the call runs, not what it runs.

    `nudge_text` (claude_guard.nudges) rides along as additionalContext on any verdict but
    a deny, and on its own when there is no decision. `updated_input` rides along the same
    way: the harness drops a rewrite beside a deny, so none is printed there."""
    if v.kind == "deny":
        nudge_text = None
        updated_input = None
    out: dict = {"hookEventName": "PreToolUse"}
    if v.kind != "none":
        out["permissionDecision"] = v.kind
        if v.kind != "allow":
            out["permissionDecisionReason"] = v.reason
    if nudge_text:
        out["additionalContext"] = nudge_text
    if updated_input:
        out["updatedInput"] = updated_input
    if len(out) == 1:
        return None
    return json.dumps({"hookSpecificOutput": out})


def wait_rewrite(event: PreToolUseEvent) -> dict | None:
    """The `cc-wait` rewrite for this call, or None. Never raises: like a nudge, the rewrite
    is an improvement, and a failure in it must leave the call as typed rather than ask."""
    try:
        return waits.rewrite(event, os.getpid())
    except Exception:
        return None


def tq_rewrite(event: PreToolUseEvent, env: Mapping[str, str]) -> dict | None:
    """The tq rewrite for this call (claude_guard.tq_wrap), or None. Never raises, for the
    reason wait_rewrite() gives.

    Claude Code replaces the tool input with updatedInput rather than merging it, so every
    other key rides along. Sending the command alone dropped run_in_background and timeout:
    a backgrounded suite ran in the foreground under the 120s default (#771)."""
    try:
        if not event.is_bash:
            return None
        updated = tq_wrap.rewrite(event.bash.command, event.cwd, env)
        return None if updated is None else {**event.tool_input, "command": updated}
    except Exception:
        return None


def apply_guard_verdict(command: str, env: Mapping[str, str]) -> Verdict | None:
    """claude_guard.apply_guard's verdict for a `chezmoi apply`, or None.

    Its failure contract is the deny side's, not no-decision: a guard that cannot complete
    asks, because the apply it guards would silently revert work."""
    try:
        return apply_guard.pre(command, env)
    except Exception:
        return Verdict(
            "ask",
            "chezmoi-apply-guard",
            "chezmoi-apply-guard: the check raised -- not evaluated, so it is unknown whether "
            "this apply reverts a file something other than chezmoi wrote. Check `chezmoi "
            "status` before approving.",
        )


def nudge_for(event: PreToolUseEvent) -> str | None:
    """The context nudge for the event's command, or None when it trips no rule or the
    session has already had that rule's nudge. Never raises: a nudge is advice, and a
    failure in it must not reach the deny side's ask."""
    try:
        if event.bash is None:
            return None
        found = nudge(event.bash.command, event.cwd or "")
        if found is None or not claim(context_transcript(event), found[0]):
            return None
        return found[1]
    except Exception:
        return None


def read_nudge_json(stdin_text: str) -> str | None:
    """The PreToolUse/Read stdout: a whole-file-read nudge as additionalContext, or None.

    None also when the session has already had that nudge, and on any failure: the Read
    hook decides nothing, so a failure in it must not stand in the way of the Read.
    """
    try:
        event = parse_event(stdin_text)
        if event is None:
            return None
        found = read_nudge(event.tool_input, event.cwd or "")
        if found is None or not claim(context_transcript(event), found[0]):
            return None
        return pre_tool_use_json(NONE, found[1])
    except Exception:
        return None


def context_transcript(event: PreToolUseEvent) -> str:
    """The transcript that records this caller's additionalContext, or "" when the payload
    names none.

    A subagent's payload carries the PARENT's `transcript_path` plus its own `agent_id`,
    and the harness writes the subagent's context to
    `<parent without .jsonl>/subagents/agent-<agent_id>.jsonl` (measured 2026-09-24: a
    nudge repeated on every call in a subagent until the lookup moved there)."""
    path = event.transcript_path
    if path is None:
        return ""
    if event.agent_id is not None and path.endswith(".jsonl"):
        return f"{path[: -len('.jsonl')]}/subagents/agent-{event.agent_id}.jsonl"
    return path


ASK_JSON = pre_tool_use_json(Verdict("ask", "exception", ASK_REASON))


def awk_verdict(command: str) -> Verdict | None:
    """claude_guard.checks.awk as a Verdict, or None (dotfiles #702). It runs here because
    the native `Bash(awk:*)` allow approves a bare awk before any PermissionRequest hook."""
    risk = awk_risk(command)
    if risk is None:
        return None
    lead = "Blocked" if risk[0] == "deny" else "Review this awk"
    return Verdict(risk[0], "awk-exec", f"{lead}: {risk[1]}")


def bypass_verdict(event: PreToolUseEvent, env: Mapping[str, str]) -> Verdict | None:
    """claude_guard.bypass's deny for a needless sandbox bypass, or None. Never raises."""
    if event.bash is None:
        return None
    return bypass.verdict(event.bash, event.cwd, env, decide)


def escape_verdict(command: str, cwd: str | None) -> Verdict | None:
    """claude_guard.checks.worktree_escape as a Verdict, or None (server#2818). It is a deny
    rule, so it runs inside pre_tool_use's fail-closed try rather than beside it. With no
    session cwd there is no worktree to escape, so it says nothing."""
    if cwd is None:
        return None
    v = worktree_escape.verdict(command, cwd)
    return Verdict(v[0], "worktree-escape", v[1]) if v else None


def read_only_agent_verdict(event: PreToolUseEvent, env: Mapping[str, str]) -> Verdict | None:
    """claude_guard.checks.read_only_agents as a Verdict, or None (dotfiles #848). It is a deny
    rule, so it runs inside pre_tool_use's fail-closed try."""
    if event.bash is None:
        return None
    v = read_only_agents.verdict(event.agent_type, event.bash.command, env)
    return Verdict(v[0], read_only_agents.RULE, v[1]) if v else None


def homelab_deploy_verdict(event: PreToolUseEvent) -> Verdict | None:
    """claude_guard.checks.homelab_deploy as a Verdict, or None (dotfiles #1321, #1326). It
    reads the payload's `permission_mode`, so it runs here rather than in deny()."""
    if event.bash is None:
        return None
    v = homelab_deploy.verdict(event.permission_mode, event.bash.command)
    return Verdict(v[0], homelab_deploy.RULE, v[1]) if v else None


def wrapped_verdict(command: str, env: Mapping[str, str]) -> Verdict | None:
    """claude_guard.wrapped's deny or ask for a wrapped command, or None. It is a deny rule, so
    it runs inside pre_tool_use's fail-closed try."""
    v = wrapped.settings_verdict(command, env)
    return Verdict(*v) if v else None


def conventions(command: str, cwd: str | None) -> Verdict | None:
    """claude_guard.checks.git_conventions as a Verdict, or None. Never raises: a failure in
    a convention check is no decision (that module's DECIDED), not the deny side's ask."""
    try:
        v = git_conventions.verdict(command, cwd or "", git_conventions.read_git_config)
    except Exception:
        return None
    return Verdict(v[0], "git-conventions", v[1]) if v else None


def combine_conventions(rules: Verdict, conv: Verdict | None) -> Verdict:
    """The deny rules' verdict and the conventions', merged the way the harness merged them
    while they were two hooks (#619): a deny from either wins, then an ask from either."""
    if conv is None or rules.kind == "deny":
        return rules
    if conv.kind == "deny" or rules.kind == "none":
        return conv
    return rules


def file_tool_json(event: PreToolUseEvent, env: Mapping[str, str]) -> str | None:
    """The deny JSON for a file-tool call whose path `claude_guard.protected_paths` lists,
    or None. The path is `file_path`, or `notebook_path` for NotebookEdit."""
    tool_input = event.tool_input
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(path, str):
        return None
    if protected_paths.protects_file(path, event.cwd or "", env.get("HOME", "")):
        return pre_tool_use_json(
            Verdict("deny", protected_paths.FILE_RULE, protected_paths.FILE_REASON)
        )
    return None


def pre_tool_use(stdin_text: str, env: Mapping[str, str]) -> str | None:
    """The deny/ask/allow JSON, or None for no decision.

    A file-tool call is judged by `file_tool_json` alone, under the same failure contract.

    Never raises. An exception in the deny rules becomes ASK_JSON: the deny side fails closed
    to ask (spec, Failure contracts), the posture the bash took on a missing jq. The
    worktree-escape check is a deny rule and shares that try, because it is the only one that
    reads the session's cwd, and so does the read-only-agent check (dotfiles #848), which
    reads the payload's `agent_type`, and so does the homelab-deploy check (dotfiles #1321),
    which reads its `permission_mode`. Unparseable
    stdin is no decision (:22-23). The git conventions run beside the deny rules and fail
    open (conventions()). The needless-bypass check (claude_guard.bypass) runs after them and
    also fails open. The read-only classifier runs last and only when nothing else
    decided, so it can never outrank a deny or an ask (#628). Before anything decides, the
    call's cwd is recorded for the headless prompt tool (claude_guard.prompt_tool), which
    never raises."""
    event = parse_event(stdin_text)
    if event is None:
        return None
    if event.tool_name in FILE_TOOLS:
        try:
            return file_tool_json(event, env)
        except Exception:
            return ASK_JSON
    prompt_tool.record_context(event, env)
    if event.bash is None:
        return None
    command, cwd = event.bash.command, event.cwd
    try:
        denied = deny(command, cwd or "", env)
        rules = merge(merge(denied, footgun(command)), awk_verdict(command))
        rules = merge(rules, escape_verdict(command, cwd))
        rules = merge(rules, read_only_agent_verdict(event, env))
        rules = merge(rules, homelab_deploy_verdict(event))
        rules = merge(rules, waits.hand_wait(command, event.bash.run_in_background))
        rules = merge(rules, wrapped_verdict(command, env))
    except Exception:
        return ASK_JSON
    verdict = combine_conventions(rules, conventions(command, cwd))
    # A needless dangerouslyDisableSandbox (claude_guard.bypass). Its own failure contract is
    # no decision, so it runs outside the deny rules' fail-closed try above.
    verdict = merge(verdict, bypass_verdict(event, env))
    # The chezmoi apply guard (claude_guard.apply_guard) asks rather than fails open, so it
    # merges like a deny rule, after the checks above so a deny from them is not delayed by
    # a chezmoi status it no longer needs.
    if verdict.kind != "deny":
        verdict = merge(verdict, apply_guard_verdict(command, env))
    if verdict.kind == "none" and cwd is not None:
        verdict = readonly(command, cwd, env) or verdict
    # One updatedInput at most. A cc-wait call is never a test run tq claims, and the wait
    # rewrite changes how the call runs, so it goes first.
    updated = wait_rewrite(event) or tq_rewrite(event, env)
    # A deny drops the nudge, so it must not spend the session's one claim.
    nudge_text = None if verdict.kind == "deny" else nudge_for(event)
    return pre_tool_use_json(verdict, nudge_text, updated)


_RANK = {"deny": 3, "ask": 2, "allow": 1, "none": 0}


def merge(danger: Verdict, slip: Verdict | None) -> Verdict:
    """One PreToolUse verdict from the deny rules and the footgun rules.

    deny beats ask beats allow, as two separate hooks' verdicts would merge in the harness.
    On a tie the deny rules win, because they ran first and carry the older message.
    """
    if slip is None or _RANK[slip.kind] <= _RANK[danger.kind]:
        return danger
    return slip


# =============================================================================================
# PostToolUse: what bash-write-fanout.sh needs a parser for
# =============================================================================================

# Each separator put back as text. The fanout's tokenizer resets its command word on `|`,
# `;` and `&`, so joining on newlines alone would let one segment's redirect target read as
# the next one's.
_SEP_TEXT = {
    "&&": " && ",
    "||": " || ",
    ";": " ; ",
    "|": " | ",
    "&": " & ",
    "newline": "\n",
    "eof": "",
}


def post_tool_use(stdin_text: str, env: Mapping[str, str]) -> str:
    """The JSON bash-write-fanout.sh reads after a Bash call: one interpreter start for both
    of the post side's questions.

    `context` is claude_guard.apply_guard.post()'s report, or null. `stripped`, present only
    when the command holds `<<`, is its shell text with every heredoc body lifted out, or
    null when the parser cannot read it -- the fanout then fans out nothing, since a write it
    cannot locate is the safe miss. A body line such as `> README.md` (a Markdown blockquote)
    must never read as a redirect, which is why the parser decides rather than a regex.
    """
    event = parse_event(stdin_text)
    command = event.bash.command if event is not None and event.bash is not None else ""
    out: dict = {"context": None}
    try:
        out["context"] = apply_guard.post(command, env)
    except Exception:
        out["context"] = (
            "chezmoi-apply-guard: the check raised -- not evaluated, so it is unknown what "
            "this --source apply left ahead of the primary source checkout. Run `chezmoi "
            "diff` to see it."
        )
    if "<<" in command:
        p = parse(command)
        out["stripped"] = (
            "".join(seg.text + _SEP_TEXT.get(seg.sep, " ") for seg in p.segments) if p.ok else None
        )
    return json.dumps(out)
