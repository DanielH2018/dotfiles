"""A hand dispatch of the server repo's `promote` workflow asks outside auto mode (dotfiles #1321).

`gh workflow run promote.yml -f sha=<sha>` deploys a commit to the live homelab outside the
merge-to-master path. In auto mode the `soft_deny` prose in `settings.base.json` governs it,
and that prose clears a dispatch the server repo's post-merge procedure prints. A settings
`ask` rule would force a prompt in auto mode too and break that procedure, and its prefix
match misses `gh workflow run -R DanielH2018/server promote.yml`. So this check reads the
argv and reads the payload's `permission_mode`, and asks only in a mode that prompts.

`verdict()` asks when a top-level segment or `$( )` body runs `gh workflow run` on a workflow
named `promote`, `promote.yml` or `promote.yaml`, by bare name or by path, with `-R`/`--repo`,
`-r`/`--ref` and the field flags read wherever they sit. It reads past the wrappers that
`gitargv.unwrap` skips (`timeout`, `nohup`, `nice`, `time`, `xargs`, `sudo`, ...). Known
residuals: a numeric workflow ID, which cannot be resolved offline; and a dispatch inside
`bash -c '…'` or an ssh payload, which `_stage_argvs` does not open. `gh api -X POST
…/dispatches` already asks through `deny.gh_api`.
"""

import posixpath

from claude_guard.deny import _stage_argvs
from claude_guard.gitargv import unwrap

RULE = "promote-dispatch"
# Modes in which Claude Code itself prompts. Auto, bypassPermissions and dontAsk are left out,
# as is a payload with no mode.
PROMPTING_MODES = frozenset({"default", "manual", "acceptEdits", "plan"})
_VALUED = frozenset({"-R", "--repo", "-r", "--ref", "-f", "--raw-field", "-F", "--field"})
_NAMES = frozenset({"promote", "promote.yml", "promote.yaml"})
REASON = (
    "Dispatching `promote` by hand deploys this commit to the live homelab outside the "
    "merge-to-master path. Approve it only if the user asked for this deploy."
)


def _positionals(args: list[str]) -> list[str]:
    """`args` without its flags. A valued flag spelled as its own word takes the next word;
    `--repo=x` and `-Rx` carry their value in the same word."""
    out = []
    i = 0
    while i < len(args):
        if args[i] in _VALUED:
            i += 2
        else:
            if not args[i].startswith("-"):
                out.append(args[i])
            i += 1
    return out


def dispatches_promote(argv: list[str]) -> bool:
    """Whether `argv`, a command word and its arguments, runs `gh workflow run` on `promote`,
    directly or behind wrappers such as `timeout 60` or `nohup`."""
    found = unwrap(argv, "gh")
    if found is None:
        return False
    words = _positionals(found[0][1:])
    if words[:2] != ["workflow", "run"] or len(words) < 3:
        return False
    return posixpath.basename(words[2]).lower() in _NAMES


def verdict(payload: dict, command: str) -> tuple[str, str] | None:
    """The `("ask", reason)` for a hand `promote` dispatch in a prompting mode, or None.

    Args:
        payload: the hook JSON; its `permission_mode` names the session's mode.
        command: the Bash command text.
    """
    if payload.get("permission_mode") not in PROMPTING_MODES:
        return None
    if not any(dispatches_promote(argv) for argv in _stage_argvs(command)):
        return None
    return ("ask", REASON)
