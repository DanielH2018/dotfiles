"""Refuse a sandbox bypass that the command does not need.

A Bash call with `dangerouslyDisableSandbox: true` runs outside the OS sandbox, so it reaches
the PermissionRequest judge instead of being auto-allowed. A 2026-10-20 replay found 251 of
1,741 such calls were plain local reads (`git log`, `git diff`, `git show`, `cat`) that
would have run inside the sandbox unchanged. This check denies that call with a message
telling the model to drop the flag, so the read runs sandboxed and needs no approval.

It denies only when every one of these holds; otherwise it says nothing:

  * the deployed user settings enable the sandbox;
  * `judge()` allows the command;
  * every stage is a read by `readonly`'s verb tables (so it writes nothing the sandbox
    could refuse);
  * no stage needs the network or runs outside the sandbox anyway (`NETWORK_WORDS`,
    `NETWORK_GIT`, and the settings' `sandbox.excludedCommands`);
  * the command names no path the sandbox refuses to read (`tables.SECRET_PATH_RE` and the
    settings' `sandbox.filesystem.denyRead`).

`judge()` knows nothing about the network or the sandbox's read list, which is why the last
two conditions exist. Failure contract: like the read-only classifier, this can only make a
call cheaper, so anything it cannot evaluate is no decision, never a deny or an ask.
"""

import json
import shlex
from collections.abc import Callable, Mapping
from pathlib import Path

from claude_guard.deny import Verdict
from claude_guard.judge import Decision, _bare_command
from claude_guard.readonly import stages_read_only
from claude_guard.segment import parse
from claude_guard.tables import SECRET_PATH_RE

# Commands that reach the network, so a bypass may be what lets them work. The readers
# among them (`dig`, `ping`, ...) are in `readonly`'s tables; the rest never pass it, and
# are listed so the exemption does not rest on that.
NETWORK_WORDS: frozenset[str] = frozenset(
    {
        "gh",
        "uv",
        "uvx",
        "curl",
        "wget",
        "docker",
        "ssh",
        "hl",
        "kubectl",
        "cc-wait",
        "dig",
        "host",
        "nslookup",
        "ping",
        "ping6",
        "traceroute",
        "tracepath",
    }
)
NETWORK_GIT: frozenset[str] = frozenset({"fetch", "push", "pull", "ls-remote", "clone"})

REASON = (
    "claude-guard: this command runs inside the sandbox, so dangerouslyDisableSandbox is not "
    "needed: every stage is a local read the sandbox allows. Run it again without "
    "dangerouslyDisableSandbox."
)


def _sandbox_settings(home: str) -> dict | None:
    """The `sandbox` block of the deployed user settings, or None when it is off."""
    data = json.loads((Path(home) / ".claude" / "settings.json").read_text())
    sandbox = data.get("sandbox") if isinstance(data, dict) else None
    if not isinstance(sandbox, dict) or sandbox.get("enabled") is not True:
        return None
    return sandbox


def _denied_reads(sandbox: dict, home: str) -> list[str]:
    paths = (sandbox.get("filesystem") or {}).get("denyRead") or []
    out = []
    for p in paths:
        if isinstance(p, str) and p:
            out.append(p)
            if p.startswith("~/"):
                out.append(home + p[1:])
                out.append("$HOME" + p[1:])
    return out


def _stage_words(command: str) -> list[list[str]] | None:
    parsed = parse(command)
    if not parsed.ok:
        return None
    stages = []
    for seg in parsed.segments:
        text = _bare_command(seg.text.strip(" \t"))
        if text:
            stages.append(shlex.split(text))
    return stages


def _needs_network_or_runs_outside(stages: list[list[str]], excluded: set[str]) -> bool:
    for argv in stages:
        word = argv[0].rsplit("/", 1)[-1] if argv else ""
        if word in NETWORK_WORDS or word in excluded:
            return True
        if word == "git" and any(a in NETWORK_GIT for a in argv[1:]):
            return True
    return False


def needless_bypass(
    command: str, cwd: str, env: Mapping[str, str], decide: Callable[..., Decision]
) -> bool:
    """True when `command` would run inside the sandbox unchanged (module docstring).

    Raises whatever reading the settings or parsing raises; `verdict` turns that into no
    decision."""
    home = env.get("HOME", "")
    if not home:
        return False
    sandbox = _sandbox_settings(home)
    if sandbox is None:
        return False
    if SECRET_PATH_RE.search(command) or any(p in command for p in _denied_reads(sandbox, home)):
        return False
    stages = _stage_words(command)
    if not stages:
        return False
    excluded = {c for c in sandbox.get("excludedCommands") or [] if isinstance(c, str)}
    if _needs_network_or_runs_outside(stages, excluded):
        return False
    if not stages_read_only(command, home):
        return False
    return decide(command, cwd, env).allow


def verdict(
    payload: Mapping, cwd: str, env: Mapping[str, str], decide: Callable[..., Decision]
) -> Verdict | None:
    """A deny for a needless `dangerouslyDisableSandbox`, or None. Never raises."""
    try:
        tool_input = payload.get("tool_input")
        if (
            not isinstance(tool_input, dict)
            or tool_input.get("dangerouslyDisableSandbox") is not True
        ):
            return None
        command = tool_input.get("command")
        if not isinstance(command, str):
            return None
        if needless_bypass(command, cwd, env, decide):
            return Verdict("deny", "needless-bypass", REASON)
    except Exception:
        return None
    return None
