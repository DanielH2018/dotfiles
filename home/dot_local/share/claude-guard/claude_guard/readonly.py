"""The PreToolUse read-only classifier: allow a Bash command that provably cannot write or exec.

Ported from the server repo's `.claude/hooks/auto-approve-readonly.py` (dotfiles #628), so the
allow reaches every repo this package's hook runs in rather than one. `classify` returns a
reason string when the WHOLE command line is read-only (every stage of every pipeline and
sequence), else None, and None is always "no decision": the prompt stands.

Safety model (deny by default), as on the server:
  * Substitution is refused outright -- $(...), backticks, ${...} -- and so is anything the
    segmenter reports as a substitution or cannot read.
  * Stages come from `claude_guard.segment`. Within a stage, shlex(punctuation_chars=True)
    makes every operator its own token, so a redirect or a paren never hides in a word.
    Backgrounding, subshells, heredocs and writes to a real file are refused.
  * Each stage's program is on `TIER1` (read-only under any argument) or passes a per-verb
    guard (`remote_guards.GUARDS` plus the ssh/docker/systemctl/ip handlers below).

Where this differs from the server copy, deliberately (the #628 plan's three decisions):
  1. The allow applies only when the session cwd is `$HOME` itself or under a trusted repo
     (`TRUSTED_REPOS`). A git read in an untrusted clone runs that clone's `core.fsmonitor`,
     `diff.external` and pager config, so git also refuses when a `cd`, `-C`, `--git-dir` or
     `--work-tree` points it anywhere else. An ssh command is judged on the remote side, where
     the host (not the directory) is the trust boundary, so the directory checks stop there.
  2. `printenv`, `docker inspect`/`config` and `systemctl show`/`cat`/`show-environment`
     refuse: each prints environment values, the reason the package's remote tables already
     leave them out.
  3. Gaps both copies shared are closed in `_GAPS`: `git diff --output=FILE` writes,
     `git grep -O<cmd>` execs, `sort --compress-program` execs. Measured 2026-09-24 on
     daniel-box: GNU getopt_long accepts any unambiguous prefix, so `sort --outp=F`,
     `sed --in-pl`, `sed --exp='1w F'` and `journalctl --cursor-f=F` each wrote a file past
     the exact-name checks in `remote_guards`. The prefix matching here closes that locally;
     the shared guards are unchanged, because the server's replay test compares against
     them until its copy is deleted.
"""

import os
import re
import shlex
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from claude_guard.checks.remote_guards import _JOURNALCTL_WRITE, GUARDS
from claude_guard.deny import Verdict
from claude_guard.segment import parse
from claude_guard.tables import READONLY_BASE, SECRET_PATH_RE, TRUSTED_SSH_HOSTS

# Repos under $HOME whose own git config is ours. Their worktrees sit inside them
# (`.claude/worktrees/`), so a prefix match covers those too. `$HOME` itself is trusted only
# as an exact match: as a prefix it would admit every clone under it.
TRUSTED_REPOS: tuple[str, ...] = ("server", ".local/share/chezmoi")

# `cd` and `false` are meaningless over ssh, so the package's remote table leaves them out.
TIER1: frozenset[str] = READONLY_BASE | frozenset({"cd", "false"})

# A program named by path runs whatever sits at that path, so `/tmp/x/cat` is not `cat`.
_SYSTEM_BIN_DIRS = frozenset({"/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"})

# --- shell structure ---------------------------------------------------------------------------

_SUBST = ("`", "$(", "${")
_OP_TOKEN = re.compile(r"[();<>&|]+\Z")  # a token made ENTIRELY of shell operators
_FORBIDDEN = frozenset({"(", ")", "&"})  # subshell / backgrounding
# Separators the segmenter cuts on. One surviving as a token means it did not (a quoted `;`
# stays inside its word and never gets here), which is a refusal, not a second stage.
_STAGE_SEPS = frozenset({";", "&&", "||", "|", "|&"})
_SAFE_REDIR_TARGETS = frozenset({"/dev/null"})


def _is_redirect(tok: str) -> bool:
    return bool(tok) and ("<" in tok or ">" in tok) and all(c in "<>&" for c in tok)


def _strip_redirects(stage: list[str]) -> list[str] | None:
    """The stage's argv with write-free redirects dropped, or None if a redirect writes.

    Allowed: input redirects (`< file`), writes and dups that target /dev/null, and fd
    duplication (`2>&1`). Any redirect that writes a real file refuses.
    """
    argv: list[str] = []
    i, n = 0, len(stage)
    while i < n:
        t = stage[i]
        if _is_redirect(t):
            if argv and argv[-1].isdigit():  # an attached fd number (the 2 in `2>`)
                argv.pop()
            if i + 1 >= n:
                return None
            target = stage[i + 1]
            if _OP_TOKEN.match(target):  # process substitution `<( ... )`
                return None
            if "<" in t and ">" not in t:
                pass  # a pure input redirect reads
            elif ">&" in t or "<&" in t:
                if not target.isdigit():
                    return None
            elif target not in _SAFE_REDIR_TARGETS:
                return None
            i += 2
            continue
        argv.append(t)
        i += 1
    return argv


# --- directories: where a git stage runs -------------------------------------------------------


@dataclass
class _Scope:
    """What the stages of one command line are judged against.

    Attributes:
        home: the session's `$HOME`, realpath'd.
        here: the directory the next stage runs in, as far as `cd` tracking can tell; None
            once a `cd` target could not be resolved. Unused on the remote side.
        remote: True inside an ssh command, where no directory is checked.
    """

    home: str
    here: str | None
    remote: bool = False


def _trusted(path: str, home: str) -> bool:
    real = os.path.realpath(path)
    if real == home:
        return True
    for repo in TRUSTED_REPOS:
        root = os.path.realpath(os.path.join(home, repo))
        if real == root or real.startswith(root + "/"):
            return True
    return False


_UNRESOLVABLE = re.compile(r"[$*?\[\]{}]")


def _resolve(target: str, base: str | None, home: str) -> str | None:
    """The absolute path `target` names from `base`, or None when this cannot know it.

    A variable, a glob, `~user` and `cd -` all depend on state the hook does not see."""
    if not target or target == "-" or _UNRESOLVABLE.search(target):
        return None
    if target == "~" or target.startswith("~/"):
        return os.path.realpath(home + target[1:])
    if target.startswith("~"):
        return None
    if os.path.isabs(target):
        return os.path.realpath(target)
    if base is None:
        return None
    return os.path.realpath(os.path.join(base, target))


def _cd(argv: list[str], scope: _Scope) -> str:
    if not scope.remote:
        args = [a for a in argv[1:] if a not in ("-L", "-P", "--")]
        target = args[0] if args else "~"
        scope.here = _resolve(target, scope.here, scope.home) if len(args) <= 1 else None
    return "cd"


# git options that point it at another directory, each of which must stay trusted.
_GIT_DIR_OPTS = frozenset({"-C", "--git-dir", "--work-tree"})


def _git_dirs_trusted(argv: list[str], scope: _Scope) -> bool:
    if scope.remote:
        return True
    where = scope.here
    i, n = 1, len(argv)
    while i < n and argv[i].startswith("-"):
        a = argv[i]
        key, eq, value = a.partition("=")
        if key in _GIT_DIR_OPTS:
            if not eq:
                if i + 1 >= n:
                    return False
                value = argv[i + 1]
                i += 1
            path = _resolve(value, where, scope.home)
            if path is None or not _trusted(path, scope.home):
                return False
            if key == "-C":
                where = path
        i += 1
    return where is not None and _trusted(where, scope.home)


# --- the gaps both copies shared (decision 3) --------------------------------------------------


def _long_abbrev(arg: str, names: tuple[str, ...] | frozenset[str]) -> bool:
    """True when `arg` is one of the long options `names`, spelled whole or abbreviated.

    getopt_long accepts any unambiguous prefix, so `--outp=F` is `--output=F`. A prefix that
    is ambiguous between two options errors out in the program, so matching it refuses a
    command that would not have run anyway."""
    if not arg.startswith("--") or len(arg) < 3:
        return False
    key = arg.split("=", 1)[0]
    return any(name.startswith(key) for name in names)


_GIT_GREP_PAGER = re.compile(r"-[A-Za-z]*O")


def _git_gap(argv: list[str]) -> bool:
    # --output=FILE writes the diff to a file under every subcommand that takes diff options.
    if any(_long_abbrev(a, ("--output",)) for a in argv[1:]):
        return True
    # `git grep -O<cmd>` / `--open-files-in-pager` runs a command on the matching files. Any
    # bare `grep` word counts as the subcommand, so `git -C dir grep` cannot hide it behind
    # an option value.
    if "grep" in argv[1:]:
        return any(
            _GIT_GREP_PAGER.match(a) or _long_abbrev(a, ("--open-files-in-pager",))
            for a in argv[1:]
        )
    return False


def _sort_gap(argv: list[str]) -> bool:
    return any(_long_abbrev(a, ("--output", "--compress-program")) for a in argv[1:])


# Every GNU sed long option. An abbreviation of any of them reads to `remote_guards.sed_readonly`
# as an unknown safe flag, so `--exp='1w F'` hid its script and `--in-pl` its in-place edit;
# here only the whole spelling of a long option passes, and the guard then reads it.
_SED_LONG = frozenset(
    {
        "--expression",
        "--file",
        "--in-place",
        "--quiet",
        "--silent",
        "--debug",
        "--posix",
        "--regexp-extended",
        "--separate",
        "--sandbox",
        "--unbuffered",
        "--null-data",
        "--zero-terminated",
        "--line-length",
        "--follow-symlinks",
        "--help",
        "--version",
    }
)


def _sed_gap(argv: list[str]) -> bool:
    for a in argv[1:]:
        if a == "--":
            return False
        if a.startswith("--") and a.split("=", 1)[0] not in _SED_LONG:
            return True
    return False


# --cursor-file=FILE writes the last cursor to FILE after printing.
_JOURNALCTL_LOCAL_WRITE = frozenset(_JOURNALCTL_WRITE) | {"--cursor-file"}


def _journalctl_gap(argv: list[str]) -> bool:
    return any(_long_abbrev(a, _JOURNALCTL_LOCAL_WRITE) for a in argv[1:])


# gawk's -E/--exec and --file read an uninspectable program, -l/--load loads a shared
# library and --include an awk file; `@load`/`@include` do the same from inside the program
# text, and `@include "inplace"` is how `-i inplace` edits files.
_AWK_SHORT = re.compile(r"-[A-Za-z]*[El]")


def _awk_gap(argv: list[str]) -> bool:
    for a in argv[1:]:
        if _long_abbrev(a, ("--exec", "--file", "--load", "--include")):
            return True
        if a.startswith("-") and not a.startswith("--") and _AWK_SHORT.match(a):
            return True
        if "@" in a:
            return True
    return False


_GAPS: dict[str, Callable[[list[str]], bool]] = {
    "git": _git_gap,
    "sort": _sort_gap,
    "sed": _sed_gap,
    "journalctl": _journalctl_gap,
    "awk": _awk_gap,
    "gawk": _awk_gap,
    "mawk": _awk_gap,
}

# The `remote_guards.GUARDS` verbs the local side admits. nvidia-smi stays out, as on the
# server: no host in the fleet has the hardware.
_LOCAL_GUARDED = frozenset(GUARDS) - {"nvidia-smi"}

# --- verbs with a local handler ----------------------------------------------------------------

_SYSTEMCTL_WRITE = frozenset(
    {
        "start",
        "stop",
        "restart",
        "reload",
        "reload-or-restart",
        "try-restart",
        "try-reload-or-restart",
        "enable",
        "disable",
        "reenable",
        "preset",
        "preset-all",
        "mask",
        "unmask",
        "link",
        "revert",
        "set-default",
        "isolate",
        "kill",
        "clean",
        "freeze",
        "thaw",
        "set-property",
        "edit",
        "daemon-reload",
        "daemon-reexec",
        "set-environment",
        "unset-environment",
        "import-environment",
        "reset-failed",
        "add-wants",
        "add-requires",
        "emergency",
        "rescue",
        "halt",
        "poweroff",
        "reboot",
        "suspend",
        "hibernate",
        "default",
        "switch-root",
    }
)
# Decision 2: these print unit `Environment=` values.
_SYSTEMCTL_SECRET = frozenset({"show", "cat", "show-environment"})


def _systemctl(argv: list[str], scope: _Scope) -> str | None:
    refused = _SYSTEMCTL_WRITE | _SYSTEMCTL_SECRET
    return None if any(a in refused for a in argv[1:]) else "systemctl"


_IP_WRITE = frozenset(
    {
        "add",
        "del",
        "delete",
        "set",
        "change",
        "replace",
        "flush",
        "append",
        "prepend",
        "save",
        "restore",
    }
)


def _ip(argv: list[str], scope: _Scope) -> str | None:
    return None if any(a in _IP_WRITE for a in argv[1:]) else "ip"


# Decision 2: `docker inspect`, `container`/`image`/`service inspect` and `config inspect`
# print a container's Env[] or a config's content.
_DOCKER_READ = frozenset(
    {
        "ps",
        "images",
        "logs",
        "version",
        "info",
        "stats",
        "top",
        "port",
        "history",
        "events",
        "diff",
        "search",
        "df",
    }
)
_DOCKER_GROUP_READ = frozenset({"ls", "logs", "ps", "df", "top", "history", "version", "events"})
_DOCKER_GROUPS = frozenset(
    {
        "network",
        "volume",
        "container",
        "image",
        "system",
        "node",
        "service",
        "config",
        "context",
        "secret",
        "stack",
        "plugin",
    }
)
# The groups whose `inspect` carries no environment, as in the package's `_DOCKER_NESTED`.
_DOCKER_INSPECT_OK = frozenset({"network", "volume", "context", "node"})
_DOCKER_VALUE_FLAGS = frozenset(
    {
        "-u",
        "--user",
        "-e",
        "--env",
        "-w",
        "--workdir",
        "-l",
        "--label",
        "--env-file",
        "--detach-keys",
    }
)


def _docker(argv: list[str], scope: _Scope) -> str | None:
    rest = argv[1:]
    if not rest:
        return None
    if rest[0] == "exec":
        # rest = ['exec', <flags...>, <container>, <inner cmd> <args...>]
        i, n = 1, len(rest)
        while i < n and rest[i].startswith("-"):
            if rest[i] == "--":
                i += 1
                break
            i += 2 if rest[i] in _DOCKER_VALUE_FLAGS else 1
        # The inner command runs in the container, so no host directory is checked for it.
        inner = _argv_readonly(rest[i + 1 :], _Scope(scope.home, None, remote=True))
        return ("docker exec " + inner) if inner else None
    if rest[0] in _DOCKER_READ:
        return "docker " + rest[0]
    if rest[0] in _DOCKER_GROUPS and len(rest) >= 2:
        sub = rest[1]
        if sub in _DOCKER_GROUP_READ or (sub == "inspect" and rest[0] in _DOCKER_INSPECT_OK):
            return f"docker {rest[0]} {sub}"
    return None


# ssh flags that change only how we connect, never what runs. Everything else refuses, which
# keeps out -L/-R/-D (forwarding), -F (another config), -A (agent) and -J/-W (proxying).
_SSH_FLAGS = frozenset({"-q", "-T", "-n", "-4", "-6"})
_SSH_VALUE_FLAGS = frozenset({"-i", "-p", "-l", "-o"})
# -o takes arbitrary config, including ProxyCommand/LocalCommand, which run a command on THIS
# machine. Only these keys pass.
_SSH_OPTIONS = frozenset(
    {
        "batchmode",
        "connectionattempts",
        "connecttimeout",
        "identitiesonly",
        "loglevel",
        "serveralivecountmax",
        "serveraliveinterval",
        "stricthostkeychecking",
    }
)
# The remote shell expands a glob after this check has run, so `/proc/self/enviro?` can
# still become a secret path over there.
_SSH_GLOB = re.compile(r"[*?\[\]\\]")


def _ssh(argv: list[str], scope: _Scope) -> str | None:
    """`ssh [opts] [user@]host CMD...` where CMD is itself read-only.

    ssh joins its remaining arguments with spaces and hands the result to the remote shell,
    so re-classifying that string is what the far side runs."""
    if scope.remote:
        return None  # a second hop is worth confirming, not recursing into
    i, n = 1, len(argv)
    while i < n:
        a = argv[i]
        if a in _SSH_FLAGS:
            i += 1
        elif a in _SSH_VALUE_FLAGS:
            if i + 1 >= n:
                return None
            if a == "-o":
                key = re.split(r"[=\s]", argv[i + 1].strip(), maxsplit=1)[0].lower()
                if key not in _SSH_OPTIONS:
                    return None
            i += 2
        elif a.startswith("-"):
            return None
        else:
            break
    if i >= n:
        return None
    host = argv[i].split("@", 1)[-1]
    if host not in TRUSTED_SSH_HOSTS:
        return None
    remote = " ".join(argv[i + 1 :])
    if not remote.strip():
        return None  # no command means an interactive shell
    if SECRET_PATH_RE.search(remote) or _SSH_GLOB.search(remote):
        return None
    return f"ssh {host}" if _classify(remote, _Scope(scope.home, None, remote=True)) else None


_HANDLERS: dict[str, Callable[[list[str], _Scope], str | None]] = {
    "ssh": _ssh,
    "docker": _docker,
    "systemctl": _systemctl,
    "ip": _ip,
}


def _argv_readonly(argv: list[str], scope: _Scope) -> str | None:
    """A reason string when one command and its arguments are read-only, else None."""
    if not argv:
        return None
    head, _, name = argv[0].rpartition("/")
    if head and head not in _SYSTEM_BIN_DIRS:
        return None
    if name == "cd":
        return _cd(argv, scope)
    if name in TIER1:
        return name
    gap = _GAPS.get(name)
    if gap and gap(argv):
        return None
    handler = _HANDLERS.get(name)
    if handler:
        return handler(argv, scope)
    if name in _LOCAL_GUARDED and GUARDS[name](argv):
        if name == "git" and not _git_dirs_trusted(argv, scope):
            return None
        return name
    return None


def _classify(command: str, scope: _Scope) -> str | None:
    stripped = command.rstrip()
    if not stripped or stripped.endswith("\\"):
        return None
    if any(s in command for s in _SUBST):
        return None
    parsed = parse(command)
    if not parsed.ok or parsed.substitutions:
        return None
    reasons = []
    for seg in parsed.segments:
        if seg.sep == "&" or seg.heredocs:
            return None
        try:
            lex = shlex.shlex(seg.text, posix=True, punctuation_chars=True)
            lex.whitespace_split = True
            stage = list(lex)
        except ValueError:
            return None
        if not stage or any(tok in _FORBIDDEN or tok in _STAGE_SEPS for tok in stage):
            return None
        argv = _strip_redirects(stage)
        if not argv or any(_OP_TOKEN.match(tok) for tok in argv):
            return None
        reason = _argv_readonly(argv, scope)
        if not reason:
            return None
        reasons.append(reason)
    return "read-only: " + " | ".join(reasons) if reasons else None


def classify(command: str, cwd: str, home: str) -> str | None:
    """A reason string when `command`, run in `cwd`, is provably read-only, else None.

    None also when `home` is empty or `cwd` is neither `home` nor inside a trusted repo."""
    if not home or not cwd:
        return None
    home = os.path.realpath(home)
    if not _trusted(cwd, home):
        return None
    return _classify(command, _Scope(home, os.path.realpath(cwd)))


def readonly(command: str, cwd: str, env: Mapping[str, str]) -> Verdict | None:
    """`classify` as an allow Verdict, or None. Never raises: a failure here is no decision,
    not the deny side's ask, because this side can only ever remove a prompt."""
    try:
        reason = classify(command, cwd, env.get("HOME", ""))
    except Exception:
        return None
    return Verdict("allow", "readonly", reason) if reason else None
