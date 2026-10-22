"""A read-only subagent may not write through Bash (dotfiles #848).

`deep-review`, `root-cause` and `migration-reviewer` describe themselves as read-only and
still list Bash, which can write a file, commit and push. Each carries `read_only: true` in
its frontmatter under `~/.claude/agents/`. A subagent's PreToolUse payload names it in
`agent_type`, its frontmatter `name:`, and `verdict()` denies three kinds of command from
one of them:

  - a write redirect whose target is not `/dev/null`, an fd, or a path under a scratch root
    (`tables.SCRATCH_ROOTS`, resolved, so a link out of /tmp does not count);
  - a command that changes files (`rm`, `mv`, `cp`, `touch`, `sed -i`, `tee`, `find
    -delete`, …) aimed anywhere but a scratch root, and a shell or `eval` whose text this
    module would have to judge a second time;
  - any git or gh verb outside a read-only set.

A `$( )` body is judged as a command of its own. A command the segmenter cannot read is
denied, since it cannot be shown to be a read.

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

from claude_guard.checks.remote_guards import (
    GIT_READONLY,
    awk_readonly,
    find_readonly,
    sed_readonly,
    sort_readonly,
    uniq_readonly,
)
from claude_guard.checks.scratch import under_scratch
from claude_guard.gitargv import invocation
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
    {"bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "source", ".", "su", "sudo", "doas"}
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
        if a.startswith("--") and a.split("=", 1)[0] in _REF_WRITE_LONG:
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
    "remote": lambda a: _first(a) in ("", "-v", "--verbose", "show", "get-url"),
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
        a.split("=", 1)[0] in ("--output", "--upload-pack", "--receive-pack", "--exec")
        for a in args
    ):
        return "names a file for git to write or a command for it to run"
    if inv.sub == "grep" and any(
        re.match(r"-[A-Za-z]*O", a) or a.startswith("--open-files") for a in args
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
        if a.startswith("-") and not a.startswith("--") and set(a[1:2]) & set("oOTdFcDX"):
            return f"passes `{a[:2]}`, which writes a file or sends a change"
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
    "cp": _destination_scratch(frozenset({"-S"})),
    "install": _destination_scratch(frozenset({"-m", "-o", "-g", "-S"})),
    "rsync": _destination_scratch(frozenset({"-e", "--rsh"})),
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


# --- the verdict -------------------------------------------------------------------------------

_MAX_DEPTH = 4


def _segment_problem(text: str, roots: tuple[str, ...]) -> str | None:
    problem = _redirect_problem(text, roots)
    if problem:
        return problem
    words = _argv(text)
    if words is None:
        return "cannot be split into words, so it cannot be shown to be a read"
    argv, via_xargs = _unwrapped(words)
    if not argv:
        return None
    name = os.path.basename(argv[0])
    if name in _SHELLS:
        return f"runs `{name}`, whose command text this hook does not judge"
    if name == "git":
        return _git_problem(argv)
    if name == "gh":
        return _gh_problem(argv)
    check = WRITERS.get(name)
    if check is None:
        return None
    if via_xargs:
        return f"runs `{name}` on arguments xargs supplies, which this hook cannot see"
    return check(argv[1:], roots)


def problem(command: str, roots: tuple[str, ...], depth: int = 0) -> str | None:
    """Why `command` writes, or None when nothing in it is a write this module knows.

    Args:
        command: the Bash text.
        roots: the scratch roots a write may land in.
        depth: how many `$( )` bodies deep this text is.
    """
    if depth > _MAX_DEPTH:
        return "nests commands deeper than this hook reads"
    parsed = parse(command)
    if not parsed.ok:
        return f"cannot be read as shell ({parsed.status}), so it cannot be shown to be a read"
    for seg in parsed.segments:
        found = _segment_problem(seg.text, roots)
        if found:
            return found
    for body in parsed.substitutions:
        found = problem(body, roots, depth + 1)
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
