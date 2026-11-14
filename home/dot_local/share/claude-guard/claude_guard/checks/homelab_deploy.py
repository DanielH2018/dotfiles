"""A hand-run write to the live homelab asks outside auto mode (dotfiles #1321, #1326, #1334).

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
levels deep. A stage that executes its stdin runs what it reads there: a `< file`, a heredoc
or herestring body, or the stage piped into it. Such a stage is a shell given no script or
`-s`, or an ssh or hl call whose remote command is empty or such a shell. The
PermissionRequest judge refuses its trusted-host allow for a command `route()` matches, so
the ask this check raises reaches the user.

A stage that feeds a pipe is read as writing every file it names and everything its own
stdin carries (dotfiles #1342). The check does not model what `sed`, `head` or `tee` do
with their operands. It over-reads instead: `grep -c x hosts/bootstrap-host.sh | sh` asks,
and no filter between the script and the shell hides the script. A `<( )` stands for the
stdout of its body wherever a file can stand: as a shell's script, after `<`, or as an
operand of a stage that feeds a pipe.

Known residuals: a numeric workflow ID, which cannot be resolved offline; a script whose
text is the argument of an `echo` or `printf` that feeds a shell (dotfiles #1346); and a
shell inside a `>( )` that reads the stage's output, or a script run by `source` or `.`
(dotfiles #1347). `gh api -X POST …/dispatches` already asks through `deny.gh_api`.
"""

import posixpath
from dataclasses import dataclass

from claude_guard.deny import _segment_argv, _stage_argvs
from claude_guard.gitargv import unwrap
from claude_guard.segment import parse, substitution_spans

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
_SHELL_LONG_VALUED = frozenset({"--rcfile", "--init-file"})
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
# The word a `<( )` is replaced by before the command is lexed, followed by its index.
_PROCSUB = "/dev/fd/claude-guard-procsub-"


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


def _shell_operand(args: list[str]) -> tuple[str, str] | None:
    """What a shell given `args` runs: `("command", text)` for a `-c` string, `("script",
    path)` for a script file, `("stdin", "")` when it reads its commands from stdin (no
    script, or `-s`), or None when it only checks syntax (`-n`) or `-c` has no string.

    A short-option cluster is read letter by letter, so `-lc` is `-l -c`; a cluster ending
    in `o` or `O` takes the next word as its value (`-o pipefail`).
    """
    command = syntax_only = stdin = False
    i = 0
    while i < len(args):
        word = args[i]
        if word in ("--", "-"):
            i += 1
            break
        if word.startswith("--"):
            i += 2 if word in _SHELL_LONG_VALUED else 1
        elif word[:1] in "-+" and len(word) > 1:
            if word[0] == "-":
                command |= "c" in word
                syntax_only |= "n" in word
                stdin |= "s" in word
            i += 2 if word[-1] in "oO" else 1
        else:
            break
    if syntax_only:
        return None
    if command:
        return ("command", args[i]) if i < len(args) else None
    if stdin or i >= len(args):
        return ("stdin", "")
    return ("script", args[i])


def _script(argv: list[str]) -> str | None:
    """The script file a shell `argv` runs, or None when `argv` runs none."""
    args = _shell_args(argv)
    operand = _shell_operand(args) if args is not None else None
    return operand[1] if operand and operand[0] == "script" else None


def _runs_bootstrap(argv: list[str]) -> bool:
    if unwrap(argv, _BOOTSTRAP) is not None:
        return True
    script = _script(argv)
    return script is not None and posixpath.basename(script) == _BOOTSTRAP


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


def _remote_text(argv: list[str]) -> str | None:
    """The remote command text of an `ssh` or `hl` call, empty when it opens a login shell,
    or None when `argv` is neither."""
    found = unwrap(argv, "hl")
    if found is not None:
        return " ".join(found[0][1:])
    found = unwrap(argv, "ssh")
    if found is not None:
        args = found[0][1:]
        host = _past_ssh_options(args, 0)
        return " ".join(args[_past_ssh_options(args, host + 1) :])
    return None


def _inner_text(argv: list[str]) -> str | None:
    """The command text `argv` hands to another shell: the remote text of an `ssh` or `hl`
    call, or the `-c` string of a shell. None when there is none."""
    remote = _remote_text(argv)
    if remote is not None:
        return remote or None
    args = _shell_args(argv)
    operand = _shell_operand(args) if args is not None else None
    return operand[1] if operand and operand[0] == "command" else None


def _runs_stdin(argv: list[str]) -> bool:
    """Whether `argv` executes what it reads on stdin: a shell reading its commands there,
    or an ssh or hl call whose remote command is empty or such a shell."""
    remote = _remote_text(argv)
    if remote is not None:
        return not remote.strip() or any(
            _runs_stdin(_redirects(inner)[0]) for inner in _stage_argvs(remote)
        )
    args = _shell_args(argv)
    operand = _shell_operand(args) if args is not None else None
    return operand is not None and operand[0] == "stdin"


def _is_redirect(word: str) -> bool:
    return bool(word) and set(word) <= set("<>&|") and ("<" in word or ">" in word)


def _redirects(argv: list[str]) -> tuple[list[str], _Stream]:
    """`argv` split into its words without redirections, and what its `<` and `<<<`
    redirections can feed its stdin.

    The lexer splits `2>/dev/null` into `2`, `>`, `/dev/null`, so a digit word before an
    operator is dropped as its fd. The lexer also drops the space that tells `-n 5 < file`
    from `5< file`, so the stream carries the target of every `<` and `<<<`, whatever its
    fd.
    """
    words: list[str] = []
    fed = _Stream()
    i = 0
    while i < len(argv):
        word = argv[i]
        if word.isdigit() and i + 1 < len(argv) and _is_redirect(argv[i + 1]):
            i += 1
            continue
        if _is_redirect(word):
            if i + 1 < len(argv) and word == "<":
                fed += _Stream(files=(argv[i + 1],))
            elif i + 1 < len(argv) and word == "<<<":
                fed += _Stream(texts=(argv[i + 1],))
            i += 2
            continue
        words.append(word)
        i += 1
    return words, fed


def _past_ssh_options(args: list[str], i: int) -> int:
    """The index of the first word at or after `i` that is not an ssh option. ssh reads
    options after the host too, and `--` ends them."""
    while i < len(args) and args[i].startswith("-"):
        if args[i] == "--":
            return i + 1
        i += 2 if args[i] in _SSH_VALUED else 1
    return i


@dataclass(frozen=True, slots=True)
class _Stream:
    """What a stage reads on stdin or writes to stdout.

    Attributes:
        files: the files whose content the stream carries. One can be a `_PROCSUB` word.
        texts: the script texts the stream carries.
    """

    files: tuple[str, ...] = ()
    texts: tuple[str, ...] = ()

    def __add__(self, other: _Stream) -> _Stream:
        return _Stream(self.files + other.files, self.texts + other.texts)

    def resolved(self, feeds: dict[str, _Stream]) -> _Stream:
        """This stream with each `_PROCSUB` word replaced by the stream `feeds` holds for it."""
        out = _Stream(texts=self.texts)
        for path in self.files:
            out += feeds.get(path, _Stream((path,)))
        return out


def _read(command: str, depth: int = 0) -> tuple[list[list[str]], _Stream]:
    """Every argv `command` runs, with redirections dropped, and what `command` writes to
    stdout. A script file fed to a stage that executes it appears as a one-word argv naming
    that file."""
    spans = substitution_spans(command)
    if spans is None:
        return [], _Stream()
    out: list[list[str]] = []
    feeds: dict[str, _Stream] = {}
    masked = ""
    last = 0
    for span in spans:
        argvs, stdout = _read(command[span.body : span.end - 1], depth)
        out.extend(argvs)
        if span.kind == "procsub" and command[span.start] == "<":
            word = f"{_PROCSUB}{len(feeds)}"
            feeds[word] = stdout
            masked += command[last : span.start] + word
            last = span.end
    masked += command[last:]

    def add(words: list[str]) -> None:
        out.append(words)
        inner = _inner_text(words) if depth < _DEPTH else None
        if inner:
            out.extend(_read(inner, depth + 1)[0])

    written = _Stream()
    piped = _Stream()
    for seg in parse(masked).segments:
        if not seg.text.strip():
            continue  # `|&` parses as `|` then an empty `&` segment
        argv = _segment_argv(seg.text)
        words, fed = _redirects(argv) if argv else ([], _Stream())
        stdin = fed + _Stream(texts=seg.heredocs) + piped
        if words:
            add(words)
            script = _script(words)
            if _runs_stdin(words):
                executed = stdin
            elif script in feeds:
                executed = _Stream((script,))
            else:
                executed = _Stream()
            executed = executed.resolved(feeds)
            out.extend([path] for path in executed.files)
            if depth < _DEPTH:
                for text in executed.texts:
                    out.extend(_read(text, depth + 1)[0])
        operands = tuple(word for word in words[1:] if not word.startswith("-"))
        stdout = (_Stream(operands) + stdin).resolved(feeds)
        if seg.sep == "|":
            piped = stdout
        else:
            piped = _Stream()
            written += stdout
    return out, written


def route(command: str) -> str | None:
    """The reason to ask when `command` runs a hand write to the live homelab, else None.

    The write is a `promote` dispatch, a `bootstrap-host.sh` run or a start of
    `homelab-reconcile`, run locally or inside an `ssh`, `hl` or `sh -c` payload.
    """
    for argv in _read(command)[0]:
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
