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
reads the remote text of an `ssh` or `hl` call and the text of a `bash -c` / `sh -c`, three
levels deep. A stage that executes its stdin runs what it reads there: a `< file`, a heredoc
or herestring body, or the stage piped into it. Such a stage is a shell given no script or
`-s`, or an ssh or hl call whose remote command is empty. The remote text and the `-c` text
read the stdin of the stage that carries them, so a shell inside either executes it
(dotfiles #1354). The PermissionRequest judge refuses its trusted-host allow for a command
`route()` matches, so the ask this check raises reaches the user.

A stage that feeds a pipe is read as writing every file it names and everything its own
stdin carries (dotfiles #1342). The check does not model what `sed`, `head` or `tee` do
with their operands. It over-reads instead: `grep -c x hosts/bootstrap-host.sh | sh` asks,
and no filter between the script and the shell hides the script. A `<( )` stands for the
stdout of its body wherever a file can stand: as a shell's script, after `<`, or as an
operand of a stage that feeds a pipe. The body of a `>( )` reads the stdout of the stage
that names it (dotfiles #1347).

An `echo` or `printf` writes its arguments as script text (dotfiles #1346). A `printf`
format is filled with its arguments in order, every conversion as `%s` is.

`source` and `.` run a script file as a shell does (dotfiles #1347).

`eval` runs its arguments as script text. A `$( )` or a backtick pair stands for the stdout
of its body wherever its text lands: in the arguments of an `eval`, in what an `echo` or
`printf` writes, or as an operand of a stage that feeds a pipe (dotfiles #1355).

A variable is followed when the same command assigns it (dotfiles #1355). The assignment
is a segment of its own (`x='...'`) or an argument of `export`, `declare`, `typeset`,
`local` or `readonly`, and its value is literal, another such variable, or a `$( )`. Every
later `$x` and `${x}` is expanded before the segment is read, in a `$( )` body and an
unquoted heredoc body too.

Known residuals: a numeric workflow ID, which cannot be resolved offline; and a variable
set any other way, such as by `read`, a `for` loop, a `${x:-default}` or the environment.
`gh api -X POST …/dispatches` already asks through `deny.gh_api`.
"""

import itertools
import posixpath
import re
import shlex
from dataclasses import dataclass

from claude_guard.assignments import split_assignments
from claude_guard.deny import _segment_argv
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
_SOURCES = ("source", ".")
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
_DECLARES = ("export", "declare", "typeset", "local", "readonly")
_DEPTH = 3
# The word a substitution is replaced by before the command is lexed is this, a number no
# other substitution has, then `_SUBSTITUTION_END`, so no such word is a prefix of another.
_SUBSTITUTION = "/dev/fd/claude-guard-substitution-"
_SUBSTITUTION_END = "-end"
_substitution_ids = itertools.count()
_NAME = r"[A-Za-z_][A-Za-z0-9_]*"
_REFERENCE = re.compile(rf"\$(?:({_NAME})|\{{({_NAME})\}})")
_DECLARED = re.compile(rf"({_NAME})=(.*)", re.DOTALL)
_CONVERSION = re.compile(r"%%|%[-+ #0]*[\d*]*(?:\.[\d*]+)?[a-zA-Z]")


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
    """The script file `argv` runs as a shell or sources, or None when `argv` runs none."""
    args = _shell_args(argv)
    if args is not None:
        operand = _shell_operand(args)
        return operand[1] if operand and operand[0] == "script" else None
    for source in _SOURCES:
        found = unwrap(argv, source)
        if found is not None:
            return found[0][1] if len(found[0]) > 1 else None
    return None


def _printed(argv: list[str]) -> tuple[str, ...]:
    """The script text an `echo` or `printf` `argv` writes, or none for another command.

    A `printf` format is filled with the arguments in order and repeats while arguments
    remain, as the shell fills it. Every conversion is filled as `%s` is. A `\\n` escape
    is read as a newline, whether or not the command expands it.
    """
    for tool in ("echo", "printf"):
        found = unwrap(argv, tool)
        if found is None:
            continue
        args = found[0][1:]
        while args and args[0].startswith("-"):
            args = args[1:]
        text = _filled(args[0], args[1:]) if tool == "printf" and args else " ".join(args)
        return (text.replace("\\n", "\n"),) if text else ()
    return ()


def _filled(template: str, args: list[str]) -> str:
    """A `printf` format `template` with `args` put in place of its conversions."""
    rest = iter(args)
    used = 0

    def fill(match: re.Match[str]) -> str:
        nonlocal used
        if match[0] == "%%":
            return "%"
        used += 1
        return next(rest, "")

    out = _CONVERSION.sub(fill, template)
    while used and used < len(args):
        before = used
        out += _CONVERSION.sub(fill, template)
        if used == before:
            break
    return out


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


def _evaluated(argv: list[str]) -> tuple[str, ...]:
    """The script text an `eval` `argv` runs, or none for another command."""
    found = unwrap(argv, "eval")
    text = " ".join(found[0][1:]) if found is not None else ""
    return (text,) if text else ()


def _substituted(text: str, variables: dict[str, str]) -> str:
    """`text` with each `$NAME` and `${NAME}` that `variables` holds replaced by its value,
    as the shell expands a heredoc body or an assigned value: no quoting, no splitting."""
    return _REFERENCE.sub(lambda ref: variables.get(ref[1] or ref[2], ref[0]), text)


def _expanded(text: str, variables: dict[str, str]) -> str:
    """`text` with each `$NAME` and `${NAME}` that `variables` holds replaced by its value,
    as the shell expands a command.

    A reference inside single quotes stays. One inside double quotes becomes part of that
    word. One outside quotes becomes a word for each field of the value.
    """
    out: list[str] = []
    quote = ""
    i = 0
    while i < len(text):
        char = text[i]
        if quote == "'":
            if char == "'":
                quote = ""
        elif char == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        elif (ref := _REFERENCE.match(text, i)) and (ref[1] or ref[2]) in variables:
            value = variables[ref[1] or ref[2]]
            if quote:
                out.append(re.sub(r'(["\\])', r"\\\1", value))
            else:
                out.append(" ".join(shlex.quote(field) for field in value.split()))
            i = ref.end()
            continue
        elif char in "'\"":
            quote = "" if quote == char else quote or char
        out.append(char)
        i += 1
    return "".join(out)


def _runs_stdin(argv: list[str]) -> bool:
    """Whether `argv` executes what it reads on stdin: a shell reading its commands there,
    or an ssh or hl call with no remote command."""
    remote = _remote_text(argv)
    if remote is not None:
        return not remote.strip()
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
        files: the files whose content the stream carries. One can be a `_SUBSTITUTION`
          word.
        texts: the script texts the stream carries. One can hold a `_SUBSTITUTION` word.
    """

    files: tuple[str, ...] = ()
    texts: tuple[str, ...] = ()

    def __add__(self, other: _Stream) -> _Stream:
        return _Stream(self.files + other.files, self.texts + other.texts)

    def resolved(self, feeds: dict[str, _Stream]) -> _Stream:
        """This stream with the stream `feeds` holds for each `_SUBSTITUTION` word put in
        place of a file that is the word, and added for a file or text that contains it."""
        out = _Stream(tuple(path for path in self.files if path not in feeds), self.texts)
        for word, feed in feeds.items():
            if any(word in item for item in self.files + self.texts):
                out += feed
        return out


def _read(
    command: str,
    depth: int = 0,
    stdin: _Stream | None = None,
    variables: dict[str, str] | None = None,
) -> tuple[list[list[str]], _Stream]:
    """Every argv `command` runs, with redirections dropped, and what `command` writes to
    stdout. A script file fed to a stage that executes it appears as a one-word argv naming
    that file.

    Args:
        command: the command text.
        depth: how many shells deep `command` sits inside the command the check was given.
        stdin: what `command` itself reads on stdin, nothing when omitted. Every stage
          that heads a pipeline reads it.
        variables: the value of each variable assigned before `command` runs.
    """
    stdin = stdin or _Stream()
    variables = dict(variables or {})
    spans = substitution_spans(command)
    if spans is None:
        return [], _Stream()
    out: list[list[str]] = []
    feeds: dict[str, _Stream] = {}
    bodies: dict[str, str] = {}
    sinks: dict[str, str] = {}
    masked = ""
    last = 0
    for span in spans:
        word = f"{_SUBSTITUTION}{next(_substitution_ids)}{_SUBSTITUTION_END}"
        target = sinks if command[span.start] == ">" else bodies
        target[word] = command[span.body : span.end - 1]
        masked += command[last : span.start] + word
        last = span.end
    masked += command[last:]

    def nested(text: str, read: _Stream, known: dict[str, str] | None = None) -> None:
        if depth < _DEPTH:
            out.extend(_read(text, depth + 1, read, known)[0])

    written = _Stream()
    piped = stdin
    for seg in parse(masked).segments:
        if not seg.text.strip():
            continue  # `|&` parses as `|` then an empty `&` segment
        for word in [word for word in bodies if word in seg.text]:
            argvs, feeds[word] = _read(bodies.pop(word), depth, variables=variables)
            out.extend(argvs)
        assigned = split_assignments(seg.text)
        if assigned is not None and not assigned.rest:
            for assignment in assigned.assignments:
                variables[assignment.name] = _substituted(assignment.value, variables)
        argv = _segment_argv(_expanded(seg.text, variables)) or []
        words, fed = _redirects(argv)
        heredocs = tuple(
            body if quoted else _substituted(body, variables)
            for body, quoted in zip(seg.heredocs, seg.heredoc_quoted, strict=True)
        )
        read = fed + _Stream(texts=heredocs) + piped
        if words:
            out.append(words)
            if words[0] in _DECLARES:
                for declared in filter(None, map(_DECLARED.fullmatch, words[1:])):
                    variables[declared[1]] = declared[2]
            inner = _inner_text(words)
            if inner:
                nested(inner, read)
            script = _script(words)
            evaluated = _evaluated(words)
            if _runs_stdin(words):
                executed = read
            elif script in feeds:
                executed = _Stream((script,))
            else:
                executed = _Stream()
            executed = (executed + _Stream(texts=evaluated)).resolved(feeds)
            out.extend([path] for path in executed.files)
            for text in executed.texts:
                if text in evaluated:
                    nested(text, read, variables)
                else:
                    nested(text, _Stream())
        operands = tuple(word for word in words[1:] if not word.startswith("-"))
        stdout = (_Stream(operands, _printed(words)) + read).resolved(feeds)
        for sink in [sink for sink in sinks if sink in seg.text]:
            out.extend(_read(sinks.pop(sink), depth, stdout, variables)[0])
        if seg.sep == "|":
            piped = stdout
        else:
            piped = stdin
            written += stdout
    for body in (bodies | sinks).values():
        out.extend(_read(body, depth, variables=variables)[0])
    return out, written


def route(command: str) -> str | None:
    """The reason to ask when `command` runs a hand write to the live homelab, else None.

    The write is a `promote` dispatch, a `bootstrap-host.sh` run or a start of
    `homelab-reconcile`, run locally or inside an `ssh`, `hl`, `sh -c` or `eval` payload.
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
