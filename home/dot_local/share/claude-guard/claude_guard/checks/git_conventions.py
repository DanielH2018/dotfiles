"""The git conventions from CLAUDE.md, decided on parsed argv (dotfiles #575, #607, #608).

    git commit --amend                      ask   "Create a new commit rather than amending
                                                   unless I ask."
    git merge (without --ff-only)           ask   "Prefer rebase over merge."
    git pull that can merge                 ask   the same rule: a pull without --ff-only or
                                                   --rebase, and without config that makes it
                                                   fast-forward-only or rebasing (#607)
    gh pr create/edit --title <prefixed>    deny  "no `feat:`/`fix:` prefix, no ticket"
    planka card title <prefixed>            deny  the planka-tracking skill's title rule, which
                                                   is the PR-title rule (#608)

The asks are asks, not denies: the user CAN ask for an amend or a merge, and the prompt is
where that request is honoured. The title rules are denies because nobody wants a
conventional-commit prefix on a squash subject or a card title here, and the reason names the
fix.

claude_guard.hook.pre_tool_use runs this beside the deny rules, in the one interpreter the
PreToolUse shim starts (#619). Before that it ran from a hook of its own,
git-conventions-guard.sh, which started a second Python on every Bash call.

Each rule reads one command's own argv, from claude_guard.segment's top-level segments and
substitutions. A substring match would ask on `git commit -m "never git commit --amend"` and
on `git merge-base --is-ancestor HEAD origin/main` (bin/land-sync's own query), and would
miss `git -C ~/repo merge topic`, where a global option sits between `git` and the verb.

DECIDED: a parse refusal, or an argv shlex cannot split, is NO DECISION here. That inverts
the package's "a refusal is never a skip" contract on purpose: these are conventions, not
safety rules. An ask on every command the parser cannot read would put a prompt in front of
shapes that break no rule, and the refusal already leaves the permission decision to the
normal flow, because the PermissionRequest side defers on it. The same posture covers a
failure inside this module: hook.pre_tool_use turns an exception here into no decision, never
into the deny side's fail-closed ask.
"""

import os
import re
import shlex
import subprocess
from collections.abc import Callable

from claude_guard.segment import parse

# git's own global options that take their value as the NEXT word. The `--opt=value` forms
# are one token and need no entry.
_GIT_GLOBAL_WITH_ARG = frozenset(
    {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"}
)

# `git commit` options whose value is the next word. Reading past them keeps a message that
# mentions --amend from reading as the flag. Short clusters are handled in _commit_flags.
_COMMIT_WITH_ARG = frozenset(
    {
        "-m",
        "-F",
        "-C",
        "-c",
        "-t",
        "--message",
        "--file",
        "--reuse-message",
        "--reedit-message",
        "--template",
        "--author",
        "--date",
        "--trailer",
        "--cleanup",
        "--fixup",
        "--squash",
        "--pathspec-from-file",
    }
)
_COMMIT_SHORT_WITH_ARG = frozenset("mFCct")

_MERGE_WITH_ARG = frozenset(
    {
        "-m",
        "-F",
        "-s",
        "-X",
        "--message",
        "--file",
        "--strategy",
        "--strategy-option",
        "--into-name",
        "--cleanup",
    }
)
# A merge that cannot create a merge commit, or is not a new merge at all.
_MERGE_EXEMPT = frozenset({"--ff-only", "--abort", "--continue", "--quit"})

_CONVENTIONAL = re.compile(
    r"^\s*(feat|fix|chore|docs|refactor|test|tests|ci|build|perf|style|revert)"
    r"(\([^)]*\))?!?\s*:",
    re.IGNORECASE,
)
_TICKET = re.compile(r"\b([A-Z]{2,10})-(\d+)\b")
# Standards and algorithm names that share the ticket shape. A pins-heavy repo titles PRs
# with these ("Bump the SHA-256 pin"), and a deny on them would be a false positive with
# nothing for the author to fix.
_NOT_TICKETS = frozenset(
    {
        "SHA",
        "UTF",
        "CVE",
        "CWE",
        "ISO",
        "RFC",
        "PEP",
        "TLS",
        "SSL",
        "HTTP",
        "AES",
        "RSA",
        "ECMA",
        "IEEE",
        "MD",
        "ED",
        "ES",
        "IPV",
    }
)

AMEND_REASON = (
    "git-conventions: `git commit --amend` rewrites a commit. CLAUDE.md: create a new commit "
    "rather than amending unless the user asked for an amend. Approve only if they did."
)
MERGE_REASON = (
    "git-conventions: `git merge` without --ff-only can create a merge commit. CLAUDE.md: "
    "prefer rebase over merge (`git rebase <upstream>`, or `git merge --ff-only`). "
    "Approve only if a merge commit is what the user wants."
)
PULL_REASON = (
    "git-conventions: this `git pull` can create a merge commit: it passes neither --ff-only "
    "nor --rebase, and git config sets neither pull.ff=only nor pull.rebase. CLAUDE.md: prefer "
    "rebase over merge (`git pull --rebase`, or `git pull --ff-only`). Approve only if a merge "
    "commit is what the user wants."
)

# `git pull` options whose value is the next word, so a value is never read as a flag.
_PULL_WITH_ARG = frozenset(
    {
        "-s",
        "-X",
        "-o",
        "-j",
        "--strategy",
        "--strategy-option",
        "--server-option",
        "--jobs",
        "--depth",
        "--deepen",
        "--shallow-since",
        "--shallow-exclude",
        "--upload-pack",
        "--negotiation-tip",
    }
)
_PULL_SHORT_WITH_ARG = frozenset("sXoj")
# git's boolean spellings of false. Any other pull.rebase value (true, merges, interactive)
# rebases.
_GIT_FALSE = frozenset({"false", "no", "off", "0", ""})

# A git config reader: (directory, keys) -> {key: value}, the last value of each key set.
ConfigReader = Callable[[str, tuple[str, ...]], dict[str, str]]


def _strip_env(argv: list[str]) -> list[str]:
    i = 0
    while i < len(argv) and "=" in argv[i] and argv[i].split("=", 1)[0].isidentifier():
        i += 1
    return argv[i:]


def _git_verb(argv: list[str]) -> tuple[str, list[str], list[str]] | None:
    """(subcommand, its arguments, git's global options before it) for a git argv."""
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    i = 1
    while i < len(argv) and argv[i].startswith("-"):
        i += 2 if argv[i] in _GIT_GLOBAL_WITH_ARG else 1
    if i >= len(argv):
        return None
    return argv[i], argv[i + 1 :], argv[1:i]


def _flags(args: list[str], with_arg: frozenset[str], short_with_arg: frozenset[str]) -> set:
    """The option tokens in `args`, skipping every option's value and stopping at `--`."""
    out: set[str] = set()
    skip = False
    for tok in args:
        if skip:
            skip = False
            continue
        if tok == "--":
            break
        if not tok.startswith("-") or tok == "-":
            continue
        out.add(tok.split("=", 1)[0] if tok.startswith("--") else tok)
        if tok in with_arg:
            skip = True
        elif not tok.startswith("--") and len(tok) > 2:
            # A short cluster: `-am msg`. The first letter that takes a value swallows the
            # rest of the token, or the next word when it is the last letter.
            for pos, ch in enumerate(tok[1:], start=1):
                if ch in short_with_arg:
                    skip = pos == len(tok) - 1
                    break
    return out


def _is_amend(flag: str) -> bool:
    # git accepts any unambiguous prefix of a long option, and --amend is the only
    # `git commit` long option starting `--am`.
    return len(flag) >= 4 and "--amend".startswith(flag)


def _title_problem(title: str) -> str | None:
    m = _CONVENTIONAL.match(title)
    if m:
        return f"it opens with the conventional-commit prefix `{title[: m.end()].strip()}`"
    for t in _TICKET.finditer(title):
        if t.group(1) not in _NOT_TICKETS:
            return f"it carries the ticket id `{t.group(0)}`"
    return None


def _pr_title(argv: list[str]) -> str | None:
    """The --title value of a `gh pr create|edit` argv, or None."""
    if len(argv) < 3 or os.path.basename(argv[0]) != "gh":
        return None
    if argv[1] != "pr" or argv[2] not in ("create", "edit"):
        return None
    args = argv[3:]
    for i, tok in enumerate(args):
        if tok == "--":
            break
        if tok in ("--title", "-t"):
            return args[i + 1] if i + 1 < len(args) else None
        if tok.startswith("--title="):
            return tok.split("=", 1)[1]
        if tok.startswith("-t") and not tok.startswith("--") and len(tok) > 2:
            return tok[2:]
    return None


def _planka_titles(argv: list[str]) -> list[str]:
    """The card titles a `planka card` argv sets: `card field --set title=<t>` and
    `card resolve --create --title <t>`. The planka CLI has no `card create` or `card edit`;
    these two are the only ways it names a card."""
    if not argv or os.path.basename(argv[0]) != "planka":
        return []
    i = 1
    while i < len(argv) and argv[i].startswith("-"):  # planka's only global option is --strict
        i += 1
    if argv[i : i + 1] != ["card"] or i + 1 >= len(argv):
        return []
    sub, args = argv[i + 1], argv[i + 2 :]
    option = {"field": "--set", "resolve": "--title"}.get(sub)
    if option is None:
        return []
    values = []
    for j, tok in enumerate(args):
        if tok == "--":
            break
        if tok == option and j + 1 < len(args):
            values.append(args[j + 1])
        elif tok.startswith(option + "="):
            values.append(tok.split("=", 1)[1])
    if sub == "resolve":
        return values
    pairs = [v.partition("=") for v in values]
    return [value for key, eq, value in pairs if key == "title" and eq]


def _pull_flags(args: list[str]) -> tuple[bool | None, bool | None]:
    """(rebase, ff_only) as a `git pull` argv sets them; None where the flags say nothing
    and git config decides. The last of a conflicting pair wins, as it does in git."""
    rebase: bool | None = None
    ff_only: bool | None = None
    skip = False
    for tok in args:
        if skip:
            skip = False
            continue
        if tok == "--":
            break
        if not tok.startswith("-") or tok == "-":
            continue
        if tok.startswith("--"):
            name, eq, value = tok.partition("=")
            if name in _PULL_WITH_ARG and not eq:
                skip = True
            elif name == "--rebase":
                rebase = not eq or value.lower() not in _GIT_FALSE
            elif name == "--no-rebase":
                rebase = False
            elif name == "--ff-only":
                ff_only = True
            elif name in ("--ff", "--no-ff"):
                ff_only = False
            continue
        for pos, ch in enumerate(tok[1:], start=1):
            if ch == "r":
                rebase = True
            elif ch in _PULL_SHORT_WITH_ARG:
                skip = pos == len(tok) - 1
                break
    return rebase, ff_only


def _inline_config(global_opts: list[str]) -> dict[str, str]:
    """Values from `git -c key=value` before the verb; a bare `-c key` means true."""
    out: dict[str, str] = {}
    for j, tok in enumerate(global_opts):
        if tok == "-c" and j + 1 < len(global_opts):
            key, eq, value = global_opts[j + 1].partition("=")
            out[key.lower()] = value if eq else "true"
    return out


def _repo_dir(global_opts: list[str], cwd: str) -> str:
    """The directory `git pull` runs in: the session cwd, moved by each `-C` in turn."""
    here = cwd
    for j, tok in enumerate(global_opts):
        if tok == "-C" and j + 1 < len(global_opts):
            here = os.path.join(here, os.path.expanduser(global_opts[j + 1]))
    return here


def read_git_config(directory: str, keys: tuple[str, ...]) -> dict[str, str]:
    """`git config` as a pull in `directory` reads it, every scope. {} when git cannot
    answer, which leaves the pull to ask."""
    if not directory or not os.path.isabs(directory):
        return {}
    pattern = "^(" + "|".join(re.escape(k) for k in keys) + ")$"
    try:
        r = subprocess.run(
            ["git", "-C", directory, "config", "--get-regexp", pattern],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except OSError, subprocess.SubprocessError:
        return {}
    out: dict[str, str] = {}
    for line in r.stdout.splitlines():
        key, _, value = line.partition(" ")
        out[key.lower()] = value
    return out


def _pull_can_merge(
    args: list[str], global_opts: list[str], cwd: str, read_config: ConfigReader
) -> bool:
    rebase, ff_only = _pull_flags(args)
    if rebase or ff_only:
        return False
    # Config is read only for a pull the flags leave open, never for any other command.
    keys = ("pull.rebase", "pull.ff")
    config = {**read_config(_repo_dir(global_opts, cwd), keys), **_inline_config(global_opts)}
    if rebase is None and config.get("pull.rebase", "false").lower() not in _GIT_FALSE:
        return False
    return not (ff_only is None and config.get("pull.ff", "").lower() == "only")


def _title_deny(what: str, title: str, problem: str, why: str) -> tuple[str, str]:
    return (
        "deny",
        f"git-conventions: {what} {title!r} is refused because {problem}. {why}: imperative, "
        "sentence case, no `feat:`/`fix:` prefix, no ticket, naming the outcome. Retitle and "
        "run it again.",
    )


def _one(argv: list[str], cwd: str, read_config: ConfigReader) -> tuple[str, str] | None:
    argv = _strip_env(argv)
    for card_title in _planka_titles(argv):
        problem = _title_problem(card_title)
        if problem:
            return _title_deny(
                "Planka card title",
                card_title,
                problem,
                "A card title follows the PR-title rule (planka-tracking skill)",
            )
    title = _pr_title(argv)
    if title is not None:
        problem = _title_problem(title)
        if problem:
            return _title_deny(
                "PR title",
                title,
                problem,
                "A squash merge makes the PR title the commit subject, so it follows the "
                "commit rules",
            )
        return None
    verb = _git_verb(argv)
    if verb is None:
        return None
    sub, args, global_opts = verb
    if sub == "commit":
        flags = _flags(args, _COMMIT_WITH_ARG, _COMMIT_SHORT_WITH_ARG)
        if any(_is_amend(f) for f in flags):
            return ("ask", AMEND_REASON)
    elif sub == "merge":
        flags = _flags(args, _MERGE_WITH_ARG, frozenset("mFsX"))
        if not flags & _MERGE_EXEMPT:
            return ("ask", MERGE_REASON)
    elif sub == "pull" and _pull_can_merge(args, global_opts, cwd, read_config):
        return ("ask", PULL_REASON)
    return None


# Every rule needs one of these words as a command name. A command naming none of them skips
# the second parse, which is most of the Bash calls the PreToolUse hook sees.
_CANDIDATE = re.compile(r"\b(git|gh|planka)\b")


def verdict(
    command: str, cwd: str = "", read_config: ConfigReader = read_git_config
) -> tuple[str, str] | None:
    """("deny" | "ask", reason) for the first rule any command in `command` breaks, with a
    deny winning over an ask. None when nothing does, or when the parser refuses (module
    docstring, DECIDED). `cwd` is the session's, for the config a bare `git pull` reads."""
    if not _CANDIDATE.search(command):
        return None
    parsed = parse(command)
    if not parsed.ok:
        return None
    pieces = [seg.text for seg in parsed.segments] + list(parsed.substitutions)
    found: tuple[str, str] | None = None
    for piece in pieces:
        try:
            argv = shlex.split(piece)
        except ValueError:
            continue
        v = _one(argv, cwd, read_config)
        if v and v[0] == "deny":
            return v
        found = found or v
    return found
