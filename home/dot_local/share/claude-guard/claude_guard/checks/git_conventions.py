"""Three git conventions from CLAUDE.md, decided on parsed argv (dotfiles #575).

    git commit --amend                      ask   "Create a new commit rather than amending
                                                   unless I ask."
    git merge (without --ff-only)           ask   "Prefer rebase over merge."
    gh pr create/edit --title <prefixed>    deny  "no `feat:`/`fix:` prefix, no ticket"

The first two are asks, not denies: the user CAN ask for an amend or a merge, and the prompt
is where that request is honoured. The title rule is a deny because nobody wants a
conventional-commit prefix on a squash subject here, and the reason names the fix.

Each rule reads one command's own argv, from claude_guard.segment's top-level segments and
substitutions. A substring match would ask on `git commit -m "never git commit --amend"` and
on `git merge-base --is-ancestor HEAD origin/main` (bin/land-sync's own query), and would
miss `git -C ~/repo merge topic`, where a global option sits between `git` and the verb.

DECIDED: a parse refusal, or an argv shlex cannot split, is NO DECISION here. That inverts
the package's "a refusal is never a skip" contract on purpose: these are conventions, not
safety rules, and guard-pre-tool-use.sh already asks on an unreadable command. A second ask
from this hook on the same text would add a prompt and no information.
"""

import json
import os
import re
import shlex

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


def _strip_env(argv: list[str]) -> list[str]:
    i = 0
    while i < len(argv) and "=" in argv[i] and argv[i].split("=", 1)[0].isidentifier():
        i += 1
    return argv[i:]


def _git_verb(argv: list[str]) -> tuple[str, list[str]] | None:
    """(subcommand, its arguments) for a git argv, reading past git's global options."""
    if not argv or os.path.basename(argv[0]) != "git":
        return None
    i = 1
    while i < len(argv) and argv[i].startswith("-"):
        i += 2 if argv[i] in _GIT_GLOBAL_WITH_ARG else 1
    if i >= len(argv):
        return None
    return argv[i], argv[i + 1 :]


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


def _one(argv: list[str]) -> tuple[str, str] | None:
    argv = _strip_env(argv)
    title = _pr_title(argv)
    if title is not None:
        problem = _title_problem(title)
        if problem:
            return (
                "deny",
                f"git-conventions: PR title {title!r} is refused because {problem}. A squash "
                "merge makes the PR title the commit subject, so it follows the commit rules: "
                "imperative, sentence case, no `feat:`/`fix:` prefix, no ticket, naming the "
                "outcome. Retitle and run it again.",
            )
        return None
    verb = _git_verb(argv)
    if verb is None:
        return None
    sub, args = verb
    if sub == "commit":
        flags = _flags(args, _COMMIT_WITH_ARG, _COMMIT_SHORT_WITH_ARG)
        if any(_is_amend(f) for f in flags):
            return ("ask", AMEND_REASON)
    elif sub == "merge":
        flags = _flags(args, _MERGE_WITH_ARG, frozenset("mFsX"))
        if not flags & _MERGE_EXEMPT:
            return ("ask", MERGE_REASON)
    return None


def verdict(command: str) -> tuple[str, str] | None:
    """("deny" | "ask", reason) for the first rule any command in `command` breaks, with a
    deny winning over an ask. None when nothing does, or when the parser refuses (module
    docstring, DECIDED)."""
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
        v = _one(argv)
        if v and v[0] == "deny":
            return v
        found = found or v
    return found


def hook_output(stdin_text: str) -> str | None:
    """The PreToolUse JSON for a hook payload, or None for no decision. Never raises."""
    try:
        command = json.loads(stdin_text)["tool_input"]["command"]
        if not isinstance(command, str):
            return None
        v = verdict(command)
    except Exception:
        return None
    if v is None:
        return None
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": v[0],
                "permissionDecisionReason": v[1],
            }
        }
    )
