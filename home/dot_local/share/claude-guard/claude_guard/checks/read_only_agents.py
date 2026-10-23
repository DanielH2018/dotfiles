"""A read-only subagent may not write through Bash (dotfiles #848).

`deep-review`, `root-cause` and `migration-reviewer` describe themselves as read-only and
still list Bash, which can write a file, commit and push. Each carries `read_only: true` in
its frontmatter under `~/.claude/agents/`. A subagent's PreToolUse payload names it in
`agent_type`, its frontmatter `name:`, and `verdict()` denies four kinds of command from
one of them:

  - a write redirect whose target is not `/dev/null`, an fd, or a path under a scratch root
    (`tables.SCRATCH_ROOTS`, resolved, so a link out of /tmp does not count);
  - a command that changes files (`rm`, `mv`, `cp`, `touch`, `sed -i`, `tee`, `find
    -delete`, …) aimed anywhere but a scratch root, and a shell or `eval` whose text this
    module would have to judge a second time;
  - any git or gh verb outside a read-only set;
  - a kubectl or docker verb outside a read-only set (dotfiles #958), and an ssh or `hl`
    command whose remote text `readonly.remote_read_only` does not show to be a read. ssh
    takes `readonly._ssh`'s options, which keep out `-o ProxyCommand=`, on any host; with
    no remote command it reads commands from stdin and is denied. `docker run`, `docker
    exec` and `kubectl exec` are runners, judged by the words they run.

A `$( )` body is judged as a command of its own. So is the command after a reserved word
(`then`, `do`). A command this module does not know may be a runner, so the arm judges what
it could run without knowing which runner it is:

  - each later word that names a command this module judges (`uv run git push`,
    `ionice git push`). For a git or gh found this way, an assignment ahead of it in the
    segment is refused when it names a variable git or gh reads (`GIT_EXTERNAL_DIFF=…
    uv run git diff`), and `PYTHONPATH=. uv run …` is not refused;
  - each argument with a space in it whose first word is a command this module knows,
    as shell text of its own (`watch 'true; rm a'`, `flock l -c 'echo x > a'`). Text that
    does not parse is denied when a word in it names a judged command. A pytest `-k`
    expression (`'not ln'`) or an XPath (`'//a[@b > 1]'`) opens with no such word, and
    is not read as shell.

After a word that names a code runner (`python`, `node`, `psql`, ...), a string argument
is code in another language, and Python's `a > b` or SQL's `where a > b` read as shell
would be a redirect. Such a string is still judged, but its redirects are not. Later words
are judged past a code runner too, since a runner's operand can carry that name
(`flock /tmp/python git push`).

A function definition, a `case`, and a command named by a variable are denied, as is a
command the segmenter cannot read, since none can be shown to be a read.

These rules narrow what an unlisted wrapper can hide; they do not close it. Known
residuals, left for the default-deny arm that replaces this denylist:

  - a redirect-only write in a string that follows a code-runner name
    (`flock /tmp/psql -c 'echo x > a'`);
  - a command string fused to its option (`flock /tmp/l -c'git push origin HEAD'`,
    `flock /tmp/l --command='git push'`), or opening with a word the module does not
    know (`watch '(rm a)'`, `frobnicate 'mytool > src/a'`);
  - a command string with no space in it (`flock /tmp/l -c 'git${IFS}push'`);
  - an assignment a runner carries to git under a name outside `_GIT_ENV`;
  - a write by an interpreter (`python3 -c "open('x','w')"`), a writer `WRITERS` does not
    list (`gzip`), a project script or test, or a scratch script the agent wrote and runs
    (dotfiles #969).

A false positive that remains is the shape a must-refuse row shares: `uv run pytest -k
'git push'` reads exactly as `flock /tmp/l -c 'git push'`, and `-k patch` as a runner
handing `patch` its argv. `-k ssh tests/` reads as an ssh to host `tests/` with no remote
command, and `-k docker` as `docker` with an operand for its verb.

The server repo has the same arm for its own agents (server #4617), reading only that
checkout's `.claude/agents/`. This one runs from the user-level PreToolUse hook, so it
covers the user-level agents in every repo.

DECIDED: a denylist for commands other than git and gh, where the server's arm keeps an
allowlist. `root-cause` reproduces a failing test and `deep-review` runs tests and linters
to check a hypothesis; both bodies say so. A test runner executes the repo's own code, which
no allowlist entry can judge, so an allowlist would either deny the work these agents exist
to do or admit `pytest` and with it every write a test can make. The denylist stops the
direct writes an agent or an injected instruction would reach for first, and git and gh,
whose writes leave the machine, keep an allowlist.

DECIDED: deny, not ask. The agent has declared that it writes nothing, so a false positive
costs it one rephrased read, and a subagent's ask has no operator watching in a headless
run.
"""

import os
import re
import shlex
from collections.abc import Callable, Mapping
from pathlib import Path

from claude_guard.assignments import PREFIX_NAMES
from claude_guard.checks.remote_guards import (
    GIT_READONLY,
    _long_abbrev,
    awk_readonly,
    find_readonly,
    sed_readonly,
    sort_readonly,
    uniq_readonly,
)
from claude_guard.checks.scratch import under_scratch
from claude_guard.gitargv import invocation
from claude_guard.readonly import (
    _DOCKER_GROUP_READ,
    _DOCKER_GROUPS,
    _DOCKER_READ,
    _SSH_FLAGS,
    _SSH_OPTIONS,
    _SSH_VALUE_FLAGS,
    remote_read_only,
)
from claude_guard.segment import parse
from claude_guard.tables import scratch_roots

RULE = "read-only-agent"


def read_only_agents(agents_dir: Path) -> set[str]:
    """The `name:` of every agent in `agents_dir` whose frontmatter sets `read_only: true`.

    A directory that cannot be read gives the empty set, and the arm then judges nothing.
    """
    names: set[str] = set()
    try:
        entries = sorted(agents_dir.glob("*.md"))
    except OSError:
        return names
    for entry in entries:
        try:
            text = entry.read_text()
        except OSError:
            continue
        if not text.startswith("---"):
            continue
        fields = {}
        for line in text[3:].split("\n---", 1)[0].splitlines():
            key, sep, value = line.partition(":")
            if sep and not key.startswith((" ", "\t")):
                fields[key.strip()] = value.strip()
        if fields.get("read_only", "").lower() == "true" and fields.get("name"):
            names.add(fields["name"])
    return names


def _scratch(path: str, roots: tuple[str, ...]) -> bool:
    """True when `path` is `/dev/null` or sits below a scratch root, both as spelled and once
    resolved. A relative path is never scratch: a `cd` earlier in the command moves it."""
    if path == "/dev/null":
        return True
    if not under_scratch(path, roots):
        return False
    real = os.path.realpath(path)
    return any(real.startswith(os.path.realpath(r) + "/") for r in roots)


# --- redirects ---------------------------------------------------------------------------------


def _mask_quotes(s: str) -> str:
    """`s` with every quoted character replaced by `_`, so a quoted `>` is not a redirect."""
    out: list[str] = []
    quote = ""
    i = 0
    while i < len(s):
        c = s[i]
        if quote:
            out.append(c if c == quote else "_")
            if c == quote:
                quote = ""
        elif c in "'\"":
            quote = c
            out.append(c)
        elif c == "\\" and i + 1 < len(s):
            out.append("__")
            i += 1
        else:
            out.append(c)
        i += 1
    return "".join(out)


# `>`, `>>`, `>|`, `&>`, `&>>`, with an optional fd number, then the target word.
_WRITE_REDIRECT = re.compile(r"(?<![<>])[0-9]*&?>>?\|?[ \t]*(?P<target>[^ \t;&|()<>]*)")


def _redirect_problem(text: str, roots: tuple[str, ...]) -> str | None:
    masked = _mask_quotes(text)
    for m in _WRITE_REDIRECT.finditer(masked):
        start, end = m.span("target")
        # The mask keeps offsets, so the target's real spelling is the same span of `text`.
        target = text[start:end]
        if re.fullmatch(r"&?[0-9]+-?|&-", target) or (
            target == "" and masked[end : end + 1] == "&"
        ):
            continue
        try:
            words = shlex.split(target)
        except ValueError:
            return "redirects output into a target this hook cannot read"
        if len(words) != 1 or not _scratch(words[0], roots):
            return f"redirects output into `{target or '?'}`"
    return None


# --- argv --------------------------------------------------------------------------------------

_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_WRAPPERS = frozenset(
    {
        "command",
        "builtin",
        "exec",
        "env",
        "nohup",
        "setsid",
        "time",
        "nice",
        "timeout",
        "stdbuf",
        "xargs",
    }
)
_SHELLS = frozenset(
    {
        "bash",
        "sh",
        "zsh",
        "dash",
        "ksh",
        "mksh",
        "ash",
        "hush",
        "yash",
        "csh",
        "tcsh",
        "fish",
        "eval",
        "source",
        ".",
        "su",
        "sudo",
        "doas",
    }
)


def _argv(text: str) -> list[str] | None:
    """The segment's words with redirects and their targets dropped, or None when it does
    not split."""
    try:
        lex = shlex.shlex(text, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        tokens = list(lex)
    except ValueError:
        return None
    words: list[str] = []
    skip = False
    for tok in tokens:
        if skip:
            skip = False
            continue
        if tok and all(c in "<>&|" for c in tok) and ("<" in tok or ">" in tok):
            if words and words[-1].isdigit():
                words.pop()
            skip = True
            continue
        if tok in ("(", ")", "{", "}", "!"):
            continue
        words.append(tok)
    return words


def _unwrapped(words: list[str]) -> tuple[list[str], bool]:
    """(the argv the segment runs, whether `xargs` feeds it arguments). A wrapper's options
    are read loosely, as `gitargv` reads them: an option-shaped word, a number, or a word
    after an option is skipped."""
    i, wrapped, via_xargs = 0, False, False
    while i < len(words):
        word = words[i]
        name = os.path.basename(word)
        if _ASSIGNMENT.match(word):
            pass
        elif name in _WRAPPERS:
            wrapped = True
            via_xargs = via_xargs or name == "xargs"
        else:
            wrapper_option = word.startswith("-") or word[:1].isdigit()
            if not wrapped or not (wrapper_option or words[i - 1].startswith("-")):
                break
        i += 1
    return words[i:], via_xargs


def _positionals(args: list[str], value_flags: frozenset[str] = frozenset()) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            return out + args[i + 1 :]
        if arg in value_flags:
            i += 2
            continue
        if not arg.startswith("-") or arg == "-":
            out.append(arg)
        i += 1
    return out


# --- git and gh --------------------------------------------------------------------------------

_GIT_READS = GIT_READONLY | frozenset(
    {
        "ls-remote",
        "show-ref",
        "merge-base",
        "check-ignore",
        "check-attr",
        "count-objects",
        "cherry",
        "range-diff",
        "help",
        "version",
        "--version",
    }
)
_REF_WRITE_LONG = frozenset(
    {
        "--delete",
        "--move",
        "--copy",
        "--force",
        "--set-upstream-to",
        "--unset-upstream",
        "--edit-description",
        "--track",
        "--annotate",
        "--sign",
        "--message",
        "--file",
        "--edit",
    }
)
_REF_LIST_MODE = frozenset(
    {"-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"}
)


def _ref_listing(args: list[str], write_short: str) -> bool:
    """True when `git branch` / `git tag` with `args` only lists refs."""
    for a in args:
        if _long_abbrev(a, _REF_WRITE_LONG):
            return False
        if a.startswith("-") and not a.startswith("--") and set(a[1:]) & set(write_short):
            return False
    if any(a.split("=", 1)[0] in _REF_LIST_MODE for a in args):
        return True
    return all(a.startswith("-") for a in args)


def _first(args: list[str]) -> str:
    return args[0] if args else ""


_GIT_READ_FORMS: dict[str, Callable[[list[str]], bool]] = {
    # The short flags differ: `-a` lists every branch but annotates a tag.
    "branch": lambda a: _ref_listing(a, "dDmMcCfut"),
    "tag": lambda a: _ref_listing(a, "dfasumFe"),
    # `-v` may sit before the subcommand (`git remote -v add`), so judge the first word
    # that is not an option.
    "remote": lambda a: _first(_positionals(a)) in ("", "show", "get-url"),
    "worktree": lambda a: _first(a) == "list",
    "stash": lambda a: _first(a) in ("list", "show"),
    "reflog": lambda a: _first(a) in ("", "show") or _first(a).startswith("-"),
    "config": lambda a: (
        bool({"--get", "--get-all", "--get-regexp", "--list", "-l"} & set(a))
        and not {"--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e"} & set(a)
    ),
}


def _git_problem(argv: list[str]) -> str | None:
    inv = invocation(argv)
    if inv is None:
        return None
    if inv.shell or not inv.sub:
        return "runs a git alias whose command this hook cannot see"
    if inv.config:
        # `-c core.pager=<cmd>` runs a command under any subcommand, `git log` included.
        return "sets git config inline"
    args = list(inv.args)
    if any(
        _long_abbrev(a, ("--output", "--upload-pack", "--receive-pack", "--exec")) for a in args
    ):
        return "names a file for git to write or a command for it to run"
    if inv.sub == "grep" and any(
        re.match(r"-[A-Za-z]*O", a) or _long_abbrev(a, ("--open-files-in-pager",)) for a in args
    ):
        return "runs a pager command from git grep"
    if inv.sub in _GIT_READS:
        return None
    read_form = _GIT_READ_FORMS.get(inv.sub)
    if read_form and read_form(args):
        return None
    return f"runs `git {inv.sub}`, which is not in the read-only set"


_GH_READ_VERBS = frozenset({"view", "list", "ls", "status", "diff", "checks"})
_GH_READ_GROUPS = frozenset({"search", "status", "help", "version", "--version"})
_GH_VALUE_FLAGS = frozenset({"-R", "--repo", "--hostname"})
# `gh api` sends a POST as soon as a field is given, whatever the endpoint.
_GH_API_BODY = ("-f", "-F", "--field", "--raw-field", "--input")


def _gh_api_problem(args: list[str]) -> str | None:
    method = "GET"
    for i, arg in enumerate(args):
        if arg in ("-X", "--method"):
            method = args[i + 1] if i + 1 < len(args) else ""
        elif arg.startswith("--method="):
            method = arg.split("=", 1)[1]
        elif arg.startswith("-X") and len(arg) > 2:
            method = arg[2:]
        elif arg.split("=", 1)[0] in _GH_API_BODY or (arg[:2] in ("-f", "-F") and len(arg) > 2):
            return "sends a request body through `gh api`, which makes it a POST"
    if method.upper() != "GET":
        return f"sends a {method or 'missing'} request through `gh api`"
    return None


def _gh_problem(argv: list[str]) -> str | None:
    words, i = argv[1:], 0
    positional: list[str] = []
    while i < len(words):
        word = words[i]
        if word in _GH_VALUE_FLAGS:
            i += 2
            continue
        if word.startswith("-") and not positional and word != "--version":
            i += 1
            continue
        positional.append(word)
        if len(positional) == 2 or (len(positional) == 1 and word == "api"):
            break
        i += 1
    group = _first(positional)
    if group == "api":
        return _gh_api_problem(words[i + 1 :])
    if group in _GH_READ_GROUPS:
        return None
    if len(positional) > 1 and positional[1] in _GH_READ_VERBS:
        return None
    return f"runs `{' '.join(['gh', *positional])}`, which is not in the read-only set"


# --- commands that change files ----------------------------------------------------------------


def _all_scratch(value_flags: frozenset[str] = frozenset(), skip: int = 0):
    """A check that every operand after the first `skip` (a mode, an owner) is scratch."""

    def check(args: list[str], roots: tuple[str, ...]) -> str | None:
        for path in _positionals(args, value_flags)[skip:]:
            if not _scratch(path, roots):
                return f"changes `{path}`"
        return None

    return check


def _destination_scratch(value_flags: frozenset[str]):
    """A check that the destination of a copy (`-t DIR`, else the last operand) is scratch."""

    def check(args: list[str], roots: tuple[str, ...]) -> str | None:
        for i, a in enumerate(args):
            if a in ("-t", "--target-directory"):
                dest = args[i + 1] if i + 1 < len(args) else ""
                return None if _scratch(dest, roots) else f"writes into `{dest}`"
            if a.startswith("--target-directory="):
                dest = a.split("=", 1)[1]
                return None if _scratch(dest, roots) else f"writes into `{dest}`"
        found = _positionals(args, value_flags)
        if not found:
            return None
        return None if _scratch(found[-1], roots) else f"writes into `{found[-1]}`"

    return check


_LINK_LONG = ("--link", "--symbolic-link", "--link-dest")


def _no_links(check: Check) -> Check:
    """`check`, after refusing the options that make a link instead of a copy: `cp -l`/`-s`
    and their long forms, and `rsync --link-dest`. A link in a scratch root that points into
    the tree carries a later scratch write there, which is why `ln` is refused."""

    def wrapped(args: list[str], roots: tuple[str, ...]) -> str | None:
        for a in args:
            if a == "--":
                break
            if _long_abbrev(a, _LINK_LONG) or (
                a.startswith("-") and not a.startswith("--") and set(a[1:]) & set("ls")
            ):
                return f"passes `{a}`, which creates a link"
        return check(args, roots)

    return wrapped


def _dd(args: list[str], roots: tuple[str, ...]) -> str | None:
    for a in args:
        if a.startswith("of=") and not _scratch(a[3:], roots):
            return f"writes into `{a[3:]}`"
    return None


def _guarded(guard: Callable[[list[str]], bool], what: str):
    def check(args: list[str], roots: tuple[str, ...]) -> str | None:
        return None if guard(["_", *args]) else what

    return check


def _in_place(args: list[str], roots: tuple[str, ...]) -> str | None:
    if any(a.startswith("-") and not a.startswith("--") and "i" in a for a in args):
        return "edits a file in place"
    return None


_TAR_WRITE_LONG = (
    "--extract",
    "--get",
    "--create",
    "--append",
    "--update",
    "--delete",
    "--catenate",
    "--concatenate",
)


def _tar(args: list[str], roots: tuple[str, ...]) -> str | None:
    first = args[0] if args else ""
    modes = first if first and not first.startswith("-") else ""
    short = "".join(a[1:] for a in args if a.startswith("-") and not a.startswith("--"))
    if set(modes + short) & set("xcruA") or any(a.startswith(_TAR_WRITE_LONG) for a in args):
        return "creates or extracts an archive"
    return None


def _curl(args: list[str], roots: tuple[str, ...]) -> str | None:
    for a in args:
        if a.startswith("--") and a.split("=", 1)[0] in (
            "--output",
            "--remote-name",
            "--remote-name-all",
            "--output-dir",
            "--upload-file",
            "--data",
            "--data-raw",
            "--data-binary",
            "--data-urlencode",
            "--form",
            "--json",
            "--cookie-jar",
            "--dump-header",
            "--request",
        ):
            return f"passes `{a.split('=', 1)[0]}`, which writes a file or sends a change"
        if a.startswith("-") and not a.startswith("--") and set(a[1:]) & set("oOTdFcDX"):
            return f"passes `{a}`, which writes a file or sends a change"
    return None


_CHEZMOI_READS = frozenset(
    {
        "diff",
        "status",
        "cat",
        "cat-config",
        "source-path",
        "target-path",
        "managed",
        "unmanaged",
        "ignored",
        "data",
        "doctor",
        "verify",
        "dump",
        "dump-config",
        "execute-template",
        "help",
        "--version",
        "--help",
    }
)


def _chezmoi(args: list[str], roots: tuple[str, ...]) -> str | None:
    found = _positionals(
        args, frozenset({"-S", "--source", "-D", "--destination", "-c", "--config"})
    )
    verb = _first(found)
    return None if verb in _CHEZMOI_READS else f"runs `chezmoi {verb}`"


Check = Callable[[list[str], tuple[str, ...]], str | None]

WRITERS: dict[str, Check] = {
    "rm": _all_scratch(),
    "rmdir": _all_scratch(),
    "unlink": _all_scratch(),
    "shred": _all_scratch(frozenset({"-n", "-s"})),
    "touch": _all_scratch(frozenset({"-d", "-t", "-r"})),
    "mkdir": _all_scratch(frozenset({"-m"})),
    "mkfifo": _all_scratch(frozenset({"-m"})),
    "truncate": _all_scratch(frozenset({"-s", "-r"})),
    "chmod": _all_scratch(skip=1),
    "chown": _all_scratch(skip=1),
    "chgrp": _all_scratch(skip=1),
    "mv": _all_scratch(frozenset({"-S", "-t"})),
    "tee": _all_scratch(),
    "cp": _no_links(_destination_scratch(frozenset({"-S"}))),
    "install": _destination_scratch(frozenset({"-m", "-o", "-g", "-S"})),
    "rsync": _no_links(_destination_scratch(frozenset({"-e", "--rsh"}))),
    "scp": _destination_scratch(frozenset({"-P", "-i", "-o", "-F", "-J"})),
    "dd": _dd,
    "sed": _guarded(sed_readonly, "runs a sed program that writes a file or runs a command"),
    "awk": _guarded(awk_readonly, "runs an awk program that writes a file or runs a command"),
    "gawk": _guarded(awk_readonly, "runs an awk program that writes a file or runs a command"),
    "find": _guarded(find_readonly, "deletes, writes or runs a command from find"),
    "sort": _guarded(sort_readonly, "writes sort's output to a file or runs a program"),
    "uniq": _guarded(uniq_readonly, "writes uniq's output to a file"),
    "perl": _in_place,
    "ruby": _in_place,
    "tar": _tar,
    "curl": _curl,
    "chezmoi": _chezmoi,
    "patch": lambda a, r: "patches files",
    "ln": lambda a, r: "creates a link, which can carry a later scratch write into the tree",
    "wget": lambda a, r: "downloads to a file",
}


# --- commands that change a cluster, a container or another machine ---------------------------

_KUBECTL_VALUE_FLAGS = frozenset(
    {
        "-n",
        "--namespace",
        "--context",
        "--cluster",
        "--user",
        "-s",
        "--server",
        "--token",
        "--as",
        "--as-group",
        "--kubeconfig",
        "-l",
        "--selector",
        "-o",
        "--output",
        "-c",
        "--container",
        "--request-timeout",
        "-f",
        "--filename",
    }
)
# `diff` is left out: it runs `KUBECTL_EXTERNAL_DIFF`.
_KUBECTL_READ = frozenset(
    {"get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "version"}
    | {"events", "wait"}
)
_KUBECTL_GROUP_READ = {
    "auth": frozenset({"can-i", "whoami"}),
    "config": frozenset({"view", "get-contexts", "current-context", "get-clusters", "get-users"}),
    "rollout": frozenset({"status", "history"}),
}
_DOCKER_FLAGS = frozenset(
    {"-H", "--host", "-c", "--context", "--config", "-l", "--log-level"}
    # `docker compose`'s own, which may sit between `compose` and its verb.
    | {"-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile"}
)
# `compose config` is left out: `--output` writes the rendered file.
_COMPOSE_READ = frozenset({"ps", "logs", "ls", "top", "images", "version", "events", "port"})


def _kubectl(args: list[str]) -> str | None:
    verbs = _positionals(args, _KUBECTL_VALUE_FLAGS)[:2]
    verb = _first(verbs)
    sub = verbs[1] if len(verbs) > 1 else ""
    # `cluster-info dump` writes files under `--output-directory`.
    if verb in ("", "exec") or verb in _KUBECTL_READ or (verb == "cluster-info" and sub != "dump"):
        return None
    if sub in _KUBECTL_GROUP_READ.get(verb, ()):
        return None
    named = verbs if verb in _KUBECTL_GROUP_READ else verbs[:1]
    return f"runs `{' '.join(['kubectl', *named])}`, which is not in the read-only set"


def _docker(args: list[str]) -> str | None:
    verbs = _positionals(args, _DOCKER_FLAGS)[:2]
    verb = _first(verbs)
    sub = verbs[1] if len(verbs) > 1 else ""
    if verb in ("", "run", "exec", "inspect") or verb in _DOCKER_READ:
        return None
    if verb in _DOCKER_GROUPS and sub in _DOCKER_GROUP_READ | {"inspect"}:
        return None
    if verb in ("container", "compose") and sub in ("run", "exec"):
        return None
    if verb == "compose" and sub in _COMPOSE_READ:
        return None
    named = verbs if verb in _DOCKER_GROUPS | {"compose"} else verbs[:1]
    return f"runs `{' '.join(['docker', *named])}`, which is not in the read-only set"


def _runs_argv(argv: list[str]) -> bool:
    """True when `argv` is a docker or kubectl verb that runs a command of its own (`docker
    run`, `docker exec`, `kubectl exec`), which the caller judges as later words."""
    name = os.path.basename(argv[0])
    if name == "kubectl":
        return _first(_positionals(argv[1:], _KUBECTL_VALUE_FLAGS)) == "exec"
    if name != "docker":
        return False
    verbs = _positionals(argv[1:], _DOCKER_FLAGS)[:2]
    if _first(verbs) in ("run", "exec"):
        return True
    return len(verbs) == 2 and verbs[0] in ("container", "compose") and verbs[1] in ("run", "exec")


def _remote_problem(host: str, command: list[str]) -> str | None:
    if not command:
        return f"opens a shell on {host}, which runs whatever reaches its stdin"
    # ssh joins its words with spaces, and the far shell reads the result.
    text = " ".join(command)
    if remote_read_only(text):
        return None
    return f"runs `{text}` on {host}, which the read-only classifier does not show to be a read"


def _ssh(args: list[str]) -> str | None:
    """Why `ssh ARGS` writes. Its options are `readonly._ssh`'s: `-o ProxyCommand=` and
    `LocalCommand=` run a command on this machine. The host is not checked, since a write is
    a write on any host."""
    i, n = 0, len(args)
    while i < n and args[i].startswith("-"):
        a = args[i]
        if a in _SSH_VALUE_FLAGS and i + 1 < n:
            key = re.split(r"[=\s]", args[i + 1].strip(), maxsplit=1)[0]
            if a == "-o" and key.lower() not in _SSH_OPTIONS:
                return f"passes ssh option `{key}`, which is not in the read-only set"
            i += 2
        elif a in _SSH_FLAGS:
            i += 1
        else:
            return f"passes ssh `{a}`, which is not in the read-only set"
    if i >= n:
        return None
    return _remote_problem(args[i].split("@", 1)[-1], args[i + 1 :])


# Each takes the words after the command name. `hl` runs its words on the homelab server.
ELSEWHERE: dict[str, Callable[[list[str]], str | None]] = {
    "kubectl": _kubectl,
    "docker": _docker,
    "ssh": _ssh,
    "hl": lambda a: _remote_problem("the homelab server", a),
}


# --- the verdict -------------------------------------------------------------------------------

_MAX_DEPTH = 4


# Reserved words that open a compound command or a clause, ahead of the command they run.
_LEADING_WORDS = frozenset({"if", "then", "else", "elif", "do", "while", "until", "time", "!"})
_CLOSING_WORDS = frozenset({"fi", "done", "esac", "}"})
# `name()` or `function name`: a function body runs later, under a name this hook cannot
# follow to its call.
_FUNCTION = re.compile(r"^\s*(function\s|[A-Za-z_][\w.:-]*\s*\(\s*\))")
# Commands that only read their arguments, so a word such as `rm` among them is data.
_DATA_READERS = frozenset(
    {
        "grep",
        "egrep",
        "fgrep",
        "rg",
        "ag",
        "ack",
        "echo",
        "printf",
        "cat",
        "ls",
        "head",
        "tail",
        "wc",
        "less",
        "more",
        "man",
        "which",
        "type",
        "whereis",
        "file",
        "stat",
        "diff",
        "ug",
        "ugrep",
        "jq",
        "yq",
        "test",
        "[",
        "[[",
    }
)
# Every name the arm judges as a command. A runner the wrapper table does not know
# (`uv run`, `ionice`, `flock`, `busybox`, `parallel`) leaves one of these as a later word.
_JUDGED = _SHELLS | frozenset({"git", "gh", "script"}) | frozenset(WRITERS) | frozenset(ELSEWHERE)
# The names judged as a LATER word. `.` is left out: there it is a directory operand
# (`uv run ruff check .`), and a runner that execs its argv cannot reach the builtin. A
# runner that hands its words to `sh -c` (`watch . /tmp/x`) reaches a scratch script, which
# running `/tmp/x` reaches without a runner.
_LATER_JUDGED = _JUDGED - {"."}
# Programs whose string arguments are code in another language, where `print(1 > 0)` read
# as shell is a redirect. Only redirects are dropped after one: the name is matched on any
# word, and a runner's operand (`flock /tmp/python ...`) can carry it.
_CODE_RUNNER = re.compile(
    r"(python|pypy)[0-9.]*|node(js)?|deno|bun|php|lua(jit)?|Rscript|julia"
    r"|sqlite3|psql|mysql|mariadb|duckdb"
)
_WORD_BREAK = re.compile(r"[\s;&|()<>`'\"]+")
# The first word of an argument read as a command string: up to the first space or
# operator, and absent when the text opens with `(` (`'(cp or mv) and not slow'`).
_FIRST_WORD = re.compile(r"\s*([^\s;&|()<>]+)")
# Words that open shell text: a command this module knows, a builtin, a reserved word.
# An argument that opens with anything else (`not ln`, `requests >= 2`) is data.
_SHELL_OPENERS = (
    _JUDGED
    | _DATA_READERS
    | _WRAPPERS
    | _LEADING_WORDS
    | frozenset({"cd", "pushd", "popd", "true", "false", ":", "export", "unset", "set"})
    | frozenset({"for", "select", "case", "{", "exit", "return", "read", "wait"})
)
# Variables git or gh read that change what it runs or where its config comes from. A
# git found as a later word checks only these among the segment's assignments, since a
# runner's own assignments (`PYTHONPATH=. uv run`, `docker run -e FOO=1 img`) do
# not show they reach git.
_GIT_ENV = re.compile(
    r"(GIT|GH|SSH|GPG)_\w*|GNUPGHOME|LESS\w*|PAGER|EDITOR|VISUAL|BROWSER|HOME|XDG_\w+|PATH"
)


def _command_problem(
    argv: list[str],
    words: list[str],
    via_xargs: bool,
    roots: tuple[str, ...],
    later: bool = False,
) -> str | None:
    """Why the command `argv` writes, or None when it is not one this module judges.
    `later` marks an `argv` found as a later word of an unknown command."""
    name = os.path.basename(argv[0])
    if "$" in argv[0] or "`" in argv[0]:
        return f"runs a command named by `{argv[0]}`, which this hook cannot resolve"
    if name in _SHELLS or name == "script":
        return f"runs `{name}`, whose command text this hook does not judge"
    if name in ("git", "gh"):
        # `GIT_PAGER`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND` and their kin make a git read
        # run a command, so a prefix must be on the judge's allowlist of inert names.
        for word in words[: len(words) - len(argv)]:
            key = word.split("=", 1)[0]
            if not _ASSIGNMENT.match(word):
                continue
            if _GIT_ENV.fullmatch(key) if later else key not in PREFIX_NAMES:
                return f"sets `{key}`, which can make {name} run a command"
        return _git_problem(argv) if name == "git" else _gh_problem(argv)
    if name not in WRITERS and name not in ELSEWHERE:
        return None
    if via_xargs:
        return f"runs `{name}` on arguments xargs supplies, which this hook cannot see"
    if name in ELSEWHERE:
        return ELSEWHERE[name](argv[1:])
    return WRITERS[name](argv[1:], roots)


def _segment_problem(
    text: str, roots: tuple[str, ...], depth: int, redirects: bool = True
) -> str | None:
    redirect = _redirect_problem(text, roots) if redirects else None
    if redirect:
        return redirect
    if _FUNCTION.match(text):
        return "defines a shell function, whose body this hook does not judge"
    words = _argv(text)
    if words is None:
        return "cannot be split into words, so it cannot be shown to be a read"
    while words and words[0] in _LEADING_WORDS:
        words = words[1:]
    if not words or words[0] in _CLOSING_WORDS:
        return None
    if words[0] == "case":
        return "runs a case statement, whose branches this hook does not judge"
    if words[0] in ("for", "select"):
        # The word list is data; the body follows `do` in a segment of its own.
        return None
    for i, word in enumerate(words):
        if os.path.basename(word) == "env" and any(
            w.startswith(("-S", "--split-string")) for w in words[i + 1 :]
        ):
            return "runs `env -S`, which splits a string into a command"
    argv, via_xargs = _unwrapped(words)
    if not argv:
        return None
    found = _command_problem(argv, words, via_xargs, roots)
    name = os.path.basename(argv[0])
    if found or (name in _JUDGED | _DATA_READERS and not _runs_argv(argv)):
        return found
    # An unknown command may be a runner, and `docker run` and `kubectl exec` are. Which
    # runner it is does not matter: judge each later word that names a command this module
    # judges, and each argument that could be a command string, without its redirects once
    # a code runner has been named.
    code = not redirects or bool(_CODE_RUNNER.fullmatch(name))
    for j in range(1, len(argv)):
        later = os.path.basename(argv[j])
        code = code or bool(_CODE_RUNNER.fullmatch(later))
        if later in _LATER_JUDGED:
            # `words`, not `argv`: an assignment ahead of the runner can reach git too.
            found = _command_problem(argv[j:], words, via_xargs, roots, later=True)
        elif any(c.isspace() for c in argv[j]):
            found = _string_problem(argv[j], roots, depth, redirects=not code)
        if found:
            return found
    return None


def _string_problem(text: str, roots: tuple[str, ...], depth: int, redirects: bool) -> str | None:
    """Why an argument that may be a command string writes. Shell text is judged as a
    command of its own, without its redirects when `redirects` is False. Text the segmenter
    cannot read (a regex, a pytest `-k` expression) is denied only when a word in it names
    a judged command. Text whose first word opens no shell text is data."""
    first = _FIRST_WORD.match(text)
    if not first:
        return None
    word = first.group(1)
    opener = os.path.basename(word)
    if not (opener in _SHELL_OPENERS or _ASSIGNMENT.match(word) or "$" in word or "`" in word):
        return None
    if parse(text).ok:
        return problem(text, roots, depth + 1, redirects=redirects)
    names = {os.path.basename(w) for w in _WORD_BREAK.split(text)}
    if names & _LATER_JUDGED:
        return "passes a command string this hook cannot read"
    return None


def problem(
    command: str, roots: tuple[str, ...], depth: int = 0, redirects: bool = True
) -> str | None:
    """Why `command` writes, or None when nothing in it is a write this module knows.

    Args:
        command: the Bash text.
        roots: the scratch roots a write may land in.
        depth: how many `$( )` bodies deep this text is.
        redirects: False for a string a code runner holds, whose `>` is not a redirect.
    """
    if depth > _MAX_DEPTH:
        return "nests commands deeper than this hook reads"
    parsed = parse(command)
    if not parsed.ok:
        return f"cannot be read as shell ({parsed.status}), so it cannot be shown to be a read"
    for seg in parsed.segments:
        found = _segment_problem(seg.text, roots, depth, redirects)
        if found:
            return found
    for body in parsed.substitutions:
        found = problem(body, roots, depth + 1, redirects)
        if found:
            return f"runs a substitution that {found}"
    return None


def verdict(payload: dict, command: str, env: Mapping[str, str]) -> tuple[str, str] | None:
    """The `("deny", reason)` for a read-only agent's write, or None.

    Args:
        payload: the hook JSON; its `agent_type` names the subagent and is absent for the
          main session.
        command: the Bash command text.
        env: the hook's environment; `HOME` locates `~/.claude/agents/` and the scratch roots.
    """
    agent = payload.get("agent_type")
    home = env.get("HOME", "")
    if not isinstance(agent, str) or not agent or not home:
        return None
    if agent not in read_only_agents(Path(home) / ".claude" / "agents"):
        return None
    found = problem(command, scratch_roots(home, env.get("TMPDIR")))
    if not found:
        return None
    return (
        "deny",
        f"Agent `{agent}` is read-only (`read_only: true` in its frontmatter), and this "
        f"command {found}. Report the change you would make instead of making it. A write "
        f"into /tmp is allowed.",
    )
