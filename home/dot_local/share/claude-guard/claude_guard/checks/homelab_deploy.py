"""A hand-run write to the live homelab asks outside auto mode (dotfiles #1321, #1326).

Three commands reconfigure the live homelab outside the merge-to-master path:

- `gh workflow run promote.yml -f sha=<sha>` deploys a commit to the cluster.
- `hosts/bootstrap-host.sh <host>` brings a host up or re-runs its setup.
- `systemctl start homelab-reconcile` re-applies a host's configuration, usually inside an
  ssh payload.

In auto mode the `soft_deny` prose in `settings.base.json` governs them, and that prose clears
a `promote` dispatch the server repo's post-merge procedure prints. A settings `ask` rule would
force a prompt in auto mode too and break that procedure, and its prefix match misses
`gh workflow run -R DanielH2018/server promote.yml` and every ssh payload. So this check reads
the argv and reads the payload's `permission_mode`, and asks only in a mode that prompts.

`route()` reads every top-level segment and `$( )` body, past the wrappers that
`gitargv.unwrap` skips (`timeout`, `nohup`, `nice`, `time`, `xargs`, `sudo`, ...). It also
reads the remote text of an `ssh` or `hl` call and the text of a `bash -c` / `sh -c`, two
levels deep. The PermissionRequest judge refuses its trusted-host allow for a command
`route()` matches, so the ask this check raises reaches the user.

Known residuals: a numeric workflow ID, which cannot be resolved offline; and a script fed
to a shell on stdin or through a heredoc (`ssh host bash -s < hosts/bootstrap-host.sh`).
`gh api -X POST …/dispatches` already asks through `deny.gh_api`.
"""

import posixpath

from claude_guard.deny import _stage_argvs
from claude_guard.gitargv import unwrap

RULE = "homelab-deploy"
# Modes in which Claude Code itself prompts. Auto, bypassPermissions and dontAsk are left out,
# as is a payload with no mode.
PROMPTING_MODES = frozenset({"default", "manual", "acceptEdits", "plan"})

PROMOTE_REASON = (
    "Dispatching `promote` by hand deploys this commit to the live homelab outside the "
    "merge-to-master path. Approve it only if the user asked for this deploy."
)
BOOTSTRAP_REASON = (
    "Running `hosts/bootstrap-host.sh` by hand reconfigures a live homelab host outside the "
    "merge-to-master path. Approve it only if the user asked to bootstrap this host."
)
RECONCILE_REASON = (
    "Starting `homelab-reconcile` by hand re-applies a live homelab host's configuration "
    "outside the merge-to-master path. Approve it only if the user asked for this reconcile."
)

_GH_VALUED = frozenset({"-R", "--repo", "-r", "--ref", "-f", "--raw-field", "-F", "--field"})
_WORKFLOWS = frozenset({"promote", "promote.yml", "promote.yaml"})
_BOOTSTRAP = "bootstrap-host.sh"
_SHELLS = ("bash", "sh", "dash", "zsh")
_SSH_VALUED = frozenset(f"-{letter}" for letter in "BbcDEeFIiJLlmOoPpQRSWw")
_SYSTEMCTL_VALUED = frozenset(
    {"-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "-s", "--signal"}
)
_RUN_VERBS = frozenset(
    {"start", "restart", "try-restart", "reload-or-restart", "try-reload-or-restart"}
)
_ENABLE_VERBS = frozenset({"enable", "reenable"})
_UNITS = frozenset({"homelab-reconcile", "homelab-reconcile.service"})
_DEPTH = 2


def _positionals(args: list[str], valued: frozenset[str]) -> list[str]:
    """`args` without its flags. A flag in `valued` spelled as its own word takes the next
    word; `--repo=x` and `-Rx` carry their value in the same word."""
    out = []
    i = 0
    while i < len(args):
        if args[i] in valued:
            i += 2
        else:
            if not args[i].startswith("-"):
                out.append(args[i])
            i += 1
    return out


def _dispatches_promote(argv: list[str]) -> bool:
    found = unwrap(argv, "gh")
    if found is None:
        return False
    words = _positionals(found[0][1:], _GH_VALUED)
    if words[:2] != ["workflow", "run"] or len(words) < 3:
        return False
    return posixpath.basename(words[2]).lower() in _WORKFLOWS


def _shell_args(argv: list[str]) -> list[str] | None:
    """The arguments after the shell word when `argv` runs one of `_SHELLS`, else None."""
    for shell in _SHELLS:
        found = unwrap(argv, shell)
        if found is not None:
            return found[0][1:]
    return None


def _runs_bootstrap(argv: list[str]) -> bool:
    if unwrap(argv, _BOOTSTRAP) is not None:
        return True
    args = _shell_args(argv)
    if args is None or "-c" in args or "-n" in args:
        return False
    script = next((a for a in args if not a.startswith("-")), "")
    return posixpath.basename(script) == _BOOTSTRAP


def _starts_reconcile(argv: list[str]) -> bool:
    found = unwrap(argv, "systemctl")
    if found is None:
        return False
    args = found[0][1:]
    words = _positionals(args, _SYSTEMCTL_VALUED)
    if not words:
        return False
    runs = words[0] in _RUN_VERBS or (words[0] in _ENABLE_VERBS and "--now" in args)
    return runs and any(unit in _UNITS for unit in words[1:])


def _inner_text(argv: list[str]) -> str | None:
    """The command text `argv` hands to another shell: the remote text of an `ssh` or `hl`
    call, or the `-c` string of a shell. None when there is none."""
    found = unwrap(argv, "hl")
    if found is not None:
        return " ".join(found[0][1:]) or None
    found = unwrap(argv, "ssh")
    if found is not None:
        args = found[0][1:]
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in _SSH_VALUED else 1
        return " ".join(args[i + 1 :]) or None
    args = _shell_args(argv)
    if args is not None and "-c" in args:
        rest = args[args.index("-c") + 1 :]
        return rest[0] if rest else None
    return None


def _argvs(command: str, depth: int = 0) -> list[list[str]]:
    out = []
    for argv in _stage_argvs(command):
        out.append(argv)
        inner = _inner_text(argv) if depth < _DEPTH else None
        if inner:
            out.extend(_argvs(inner, depth + 1))
    return out


def route(command: str) -> str | None:
    """The reason to ask when `command` runs a hand write to the live homelab, else None.

    The write is a `promote` dispatch, a `bootstrap-host.sh` run or a start of
    `homelab-reconcile`, run locally or inside an `ssh`, `hl` or `sh -c` payload.
    """
    for argv in _argvs(command):
        if _dispatches_promote(argv):
            return PROMOTE_REASON
        if _runs_bootstrap(argv):
            return BOOTSTRAP_REASON
        if _starts_reconcile(argv):
            return RECONCILE_REASON
    return None


def verdict(payload: dict, command: str) -> tuple[str, str] | None:
    """The `("ask", reason)` for a hand homelab write in a prompting mode, or None.

    Args:
        payload: the hook JSON; its `permission_mode` names the session's mode.
        command: the Bash command text.
    """
    if payload.get("permission_mode") not in PROMPTING_MODES:
        return None
    reason = route(command)
    return ("ask", reason) if reason else None
