"""The chezmoi apply guard: the hooks/chezmoi-apply-guard.sh port.

Before a Bash call (`pre`): stop a `chezmoi apply` that would revert a deployed file
something other than chezmoi wrote, or deploy from a primary source checkout behind
origin/main. After one (`post`): report what an `apply --source <worktree>` left ahead of the
primary checkout. It rides on the claude_guard process both Bash hooks already start, so a
Bash call that names chezmoi no longer starts an interpreter of its own for it.

Worktree jobs deploy a build straight to its target path to exercise it in a real terminal,
so on this machine "deployed differs from source" usually means the deployed copy is AHEAD,
not stale, and the deployed bytes are the only copy. A parallel session running `chezmoi
apply` then silently reverts it: on 2026-07-24 an in-progress agentview build was reverted
mid-test. `chezmoi status` distinguishes the two cases exactly. Its first column is the
deployed file against the last state chezmoi wrote, the second is what apply will do:

  " M path"   source edited, deployed untouched   -> the normal workflow, allowed
  "MM path"   deployed edited outside chezmoi     -> apply would discard it, denied

Override for a deliberate revert:  CHEZMOI_APPLY_GUARD=off chezmoi apply ...

WHICH command is an apply, and WHICH paths it names, are decided by claude_guard.segment and
not by globbing the flattened command text. Four measured misreadings of the text version:

  chezmoi apply 2>&1 | tee /tmp/apply.log   ALLOWED a clobbering apply: the target scan took
  cd /tmp && chezmoi apply                  every /-rooted token in the WHOLE command, so a
                                            log path or a `cd` argument narrowed the guard to
                                            a directory no conflict could be under.
  echo CHEZMOI_APPLY_GUARD=off; chezmoi apply   ALLOWED: the override matched anywhere.
  git commit -m "fix chezmoi apply guard"   DENIED a commit: the words matched wherever.
  chezmoi apply -n                          DENIED although `-n` IS the dry-run flag.

A command the parser calls unreadable (an unbalanced quote) falls back to the flattened-text
scan, which is looser, never stricter: it no longer matches words inside quoted text or a
quoted heredoc body (#614), and it never takes the stale-source refusal.

Failure contracts. A guard that fails open on the shapes an agent types is worse than none,
because the session believes it ran, so a check that cannot complete ASKS before the apply
(naming what did not finish) and is REPORTED after it. A Bash call never stops because the
post side failed. No chezmoi on PATH is no decision: nothing is managed. Every chezmoi child
is bounded (claude_guard.bounded); the three local git reads are not (DECIDED below).
"""

import os
import re
import shlex
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from shutil import which

from claude_guard import bounded
from claude_guard.deny import Verdict
from claude_guard.segment import parse

Runner = Callable[..., bounded.Result]

OVERRIDE = "CHEZMOI_APPLY_GUARD=off"
DIFF_LIMIT = 6000


@dataclass
class Decision:
    """What the command asks chezmoi to do.

    Attributes:
        writes: whether some chezmoi command in it writes deployed files.
        offset: where the first such command starts, for the override the messages suggest.
        reads_primary: whether an apply reads the primary source checkout, which the
            stale-source refusal is about. Never set by the text fallback.
        sourced: whether an apply reads `--source <dir>`, which the post side reports on.
        targets: the absolute or `~/` paths the applies named.
    """

    writes: bool = False
    offset: int = 0
    reads_primary: bool = False
    sourced: bool = False
    targets: list[str] = field(default_factory=list)


def _arguments(argv: list[str]) -> list[str]:
    """argv without its redirections.

    A token made only of operator characters ALWAYS takes the next word: `2>`, `&>` and
    `2>>` are operators just as `>` is, and treating them as anything else let `chezmoi apply
    2> /dev/null` narrow the guard to /dev/null and run.
    """
    out, skip_next = [], False
    for tok in argv:
        if skip_next:
            skip_next = False
            continue
        bare = tok.lstrip("0123456789")
        if bare and set(bare) <= {"<", ">", "&"}:
            skip_next = True
            continue
        if tok.startswith((">", "<")) or (tok[:1].isdigit() and (">" in tok or "<" in tok)):
            continue
        out.append(tok)
    return out


def _split(piece: str) -> tuple[list[str], bool]:
    """shlex.split, keeping the tokens read before a quoting error.

    A segment carries its heredoc body, so one odd `"` in a PR body made the whole command
    unreadable and sent it to the text fallback (#614). The prefix is enough whenever it
    already holds the command word; the caller decides that.
    """
    lex = shlex.shlex(piece, posix=True)
    lex.whitespace_split = True
    lex.commenters = ""
    toks: list[str] = []
    try:
        for tok in lex:
            toks.append(tok)
    except ValueError:
        return toks, False
    return toks, True


def parsed_decision(command: str) -> Decision | None:
    """The parser's decision, or None when it cannot read a chezmoi command in `command`."""
    p = parse(command)
    if not p.ok:
        return None
    # Substitutions as well as top-level segments: `$(chezmoi apply)` runs an apply. Each
    # top-level segment carries where it starts, so the override can be put on the chezmoi
    # command rather than on whatever the command line opens with.
    pieces: list[tuple[str, int]] = []
    cursor = 0
    for seg in p.segments:
        at = command.find(seg.text, cursor)
        if at < 0:
            at = cursor
        cursor = at + len(seg.text)
        # A segment after a separator starts with the whitespace that followed it.
        pieces.append((seg.text, at + len(seg.text) - len(seg.text.lstrip())))
    pieces.extend((sub, 0) for sub in p.substitutions)

    d = Decision()
    for piece, offset in pieces:
        argv, whole = _split(piece)
        # Leading assignments are the only place the override counts, because they are the
        # only place bash would let it reach the chezmoi process. It is also PER command:
        # `CHEZMOI_APPLY_GUARD=off chezmoi apply ~/x && chezmoi apply` guards the second.
        overridden = False
        i = 0
        while i < len(argv) and "=" in argv[i] and argv[i].split("=", 1)[0].isidentifier():
            overridden = overridden or argv[i] == OVERRIDE
            i += 1
        if overridden:
            continue
        if not whole:
            # A failed split decides nothing unless its prefix reached a command word other
            # than chezmoi. A refusal is never a skip.
            if i < len(argv) and os.path.basename(argv[i]) != "chezmoi":
                continue
            return None
        if i >= len(argv) or os.path.basename(argv[i]) != "chezmoi":
            continue
        rest = _arguments(argv[i + 1 :])
        # `apply` writes; so do `update` (pull + apply) and `init --apply`. Matched as whole
        # tokens, loose about WHERE they sit: a verb this misses is a guard that does not fire.
        if not ({"apply", "update", "--apply"} & set(rest)):
            continue
        # --dry-run writes nothing; `-n` is its short form.
        if {"--dry-run", "-n"} & set(rest):
            continue
        if not d.writes:
            d.offset = offset
        d.writes = True
        # `--source <dir>` / `-S <dir>` names the source tree, not a target, and marks the
        # apply as deploying from somewhere other than the primary checkout.
        skip_next = False
        piece_sourced = False
        for t in rest:
            if skip_next:
                skip_next = False
                continue
            if t in ("--source", "-S"):
                skip_next = True
                piece_sourced = True
                continue
            if t.startswith("--source=") or (t.startswith("-S") and len(t) > 2):
                piece_sourced = True
                continue
            if t.startswith(("/", "~/")):
                d.targets.append(t)
        # A stale primary source only matters to an apply that reads it. An --source apply
        # reads another tree, and update / init --apply pull before applying.
        d.sourced = d.sourced or piece_sourced
        if not piece_sourced and not ({"update", "--apply"} & set(rest)):
            d.reads_primary = True
    return d


_HEREDOC = re.compile(r"""<<-?[ \t]*('[A-Za-z0-9_]+'|"[A-Za-z0-9_]+")""")


def literal_free(command: str) -> str:
    """The command with text that can never execute removed, for the text fallback (#614).

    That is a quoted-delimiter heredoc body, a single-quoted string, and a double-quoted
    string with no `$(` or backtick in it. Words outside quotes, a double-quoted string that
    runs a substitution, and an unquoted-delimiter heredoc body (it expands substitutions)
    all stay.
    """
    out_lines = []
    quote = ""
    buf = ""
    heredoc = ""
    heredoc_tabs = False
    for line in command.split("\n"):
        if heredoc:
            t = line.lstrip("\t") if heredoc_tabs else line
            if t == heredoc:
                heredoc = ""
            continue
        pending = ""
        m = _HEREDOC.search(line)
        if m and (m.start() == 0 or line[m.start() - 1] != "<"):
            d = line[m.start() + 2 : m.end()]
            heredoc_tabs = d.startswith("-")
            pending = re.sub(r"""[- \t"']""", "", d)
        out = []
        i = 0
        while i < len(line):
            c = line[i]
            nxt = line[i + 1 : i + 2]
            if quote == "'":
                if c == "'":
                    quote = ""
            elif quote == '"':
                if c == "\\":
                    buf += c + nxt
                    i += 1
                elif c == '"':
                    quote = ""
                    if "$(" in buf or "`" in buf:
                        out.append(f'"{buf}"')
                    buf = ""
                else:
                    buf += c
            elif c == "\\":
                out.append(c + nxt)
                i += 1
            elif c == "'":
                quote = "'"
            elif c == '"':
                quote = '"'
                buf = ""
            else:
                out.append(c)
            i += 1
        if quote == '"':
            buf += " "
        out_lines.append("".join(out))
        heredoc = pending
    return "\n".join(out_lines)


def text_decision(command: str) -> Decision:
    """The flattened-text scan, for a command the parser cannot read.

    Never `reads_primary`: the stale-source refusal is parser-only, so this fallback stays
    no stricter than the hook it preserves. Offset 0, since with no segmentation there is
    nothing better to point at than the start of the command.
    """
    # Continuations collapse, so a `\`-split cannot hide the verb. The trailing newline
    # becomes the space a trailing `-n` needs to read as a token.
    scan = re.sub(r"[\n\t\\]", " ", literal_free(command) + "\n")
    if OVERRIDE in scan:
        return Decision()
    if not re.search(r"chezmoi.*( apply| update|--apply)", scan, re.S):
        return Decision()
    if " --dry-run" in scan or " -n " in scan:
        return Decision()
    return Decision(
        writes=True,
        sourced=" --source" in scan or " -S" in scan,
        targets=[t for t in scan.split(" ") if t.startswith(("/", "~/"))],
    )


def decide(command: str) -> Decision:
    return parsed_decision(command) or text_decision(command)


def _timeout(env: Mapping[str, str], default: int) -> int:
    value = env.get("CHEZMOI_APPLY_GUARD_TIMEOUT_S", "")
    return int(value) if value.isdigit() else default


def _expand(target: str, env: Mapping[str, str]) -> str:
    return env.get("HOME", "") + target[1:] if target.startswith("~") else target


def _chezmoi(env: Mapping[str, str]) -> str | None:
    """chezmoi on the caller's PATH, never on this process's own."""
    return which("chezmoi", path=env.get("PATH", ""))


def _git(args: list[str], env: Mapping[str, str], run: Runner) -> str | None:
    r = run(["git", *args], 5, 65536, env)
    return r.out if r.status == "ok" and r.exit == 0 else None


def pre(command: str, env: Mapping[str, str], run: Runner = bounded.run) -> Verdict | None:
    """The deny or ask for an apply that would revert work, or None to let it run.

    The bounds fit inside the shim's judge bound: 2s for source-path and 5s for status.
    CHEZMOI_APPLY_GUARD_TIMEOUT_S sets both, for the tests.
    """
    if "chezmoi" not in command:
        return None
    czm = _chezmoi(env)
    if czm is None:
        return None
    d = decide(command)
    if not d.writes:
        return None
    # The override goes on the chezmoi command, not on whatever the line opens with: the
    # assignment only reaches the process it prefixes.
    override = f"{command[: d.offset]}{OVERRIDE} {command[d.offset :]}"

    def ask(what: str) -> Verdict:
        return Verdict(
            "ask",
            "chezmoi-apply-guard",
            f"chezmoi-apply-guard: {what} -- not evaluated, so it is unknown whether this apply "
            "reverts a file something other than chezmoi wrote, or deploys from a source "
            "checkout behind origin/main. Check `chezmoi status` before approving. To skip "
            f"the guard:\n\n  {override}",
        )

    # A primary source checkout behind origin/main. bin/land merges by pushing
    # <branch>:main, which moves origin/main and nothing else. An apply before bin/land-sync
    # reads the stale working tree and redeploys pre-landing content, silently reverting what
    # just landed, and `chezmoi diff` stays quiet because deployed and stale source agree
    # (#583). Against the LOCAL origin/main ref with no fetch: measured on 2026-09-23, `git
    # rev-list --count` answered in under 10ms, `git ls-remote origin` in 0.64-0.69s.
    #
    # DECIDED: the three git calls run with a generous 5s bound rather than a tight one. They
    # read local refs only, answered in under 10ms when measured, and any failure is no
    # opinion. chezmoi's own lookups are bounded tightly, since chezmoi reads config and
    # templates that can stall (#657).
    if d.reads_primary:
        t = _timeout(env, 2)
        r = run([czm, "source-path"], t, 65536, env)
        if r.status != "ok":
            return ask(f"`chezmoi source-path` did not answer within {t}s ({r.status})")
        src = r.out if r.exit == 0 else ""
        if src and os.path.isdir(src):
            behind = _git(
                ["-C", src, "rev-list", "--count", "HEAD..refs/remotes/origin/main"], env, run
            )
            if behind and behind.isdigit() and int(behind) > 0:
                top = _git(["-C", src, "rev-parse", "--show-toplevel"], env, run) or src
                branch = _git(["-C", src, "symbolic-ref", "--short", "-q", "HEAD"], env, run) or ""
                if branch == "main":
                    fix = (
                        "The checkout is on main, so bin/land-sync fast-forwards it. bin/land "
                        "runs that sync itself after every landing, so a checkout still behind "
                        "means a landing exited 3 (landed, sync failed) or main moved some "
                        "other way. Run bin/land-sync, then apply again."
                    )
                else:
                    fix = (
                        f"The checkout is on {branch or 'a detached HEAD'}, not main. "
                        "bin/land-sync advances the main ref without leaving it; the switch "
                        "back is `bin/try --back`, which deploys to the operator's live $HOME "
                        "and is theirs to run."
                    )
                return Verdict(
                    "deny",
                    "chezmoi-apply-guard",
                    f"chezmoi apply reads its source from {top}, which is {behind} commit(s) "
                    "behind origin/main. Applying now redeploys the pre-landing content and "
                    "silently reverts what landed, and `chezmoi diff` does not show it.\n\n"
                    f"{fix}\n\nThis compares against the local origin/main ref; nothing was "
                    f"fetched. If deploying the older source is deliberate:\n\n  {override}",
                )

    # Whole-tree status, which avoids parsing chezmoi's own flags out of the command to find
    # the targets. A status that fails, times out, or is cut off is not a clean tree (#657).
    t = _timeout(env, 5)
    r = run([czm, "status", "--path-style=absolute"], t, 1048576, env)
    if r.status != "ok":
        return ask(f"`chezmoi status` did not finish within {t}s ({r.status})")
    if r.exit != 0:
        return ask(f"`chezmoi status` failed (exit {r.exit})")
    # Column 1 in [ADM]: the deployed entry changed since chezmoi last wrote it. Column 2 in
    # [ADM]: apply would overwrite that change. Both, and only both.
    conflicts = [ln for ln in r.out.split("\n") if re.match(r"^[ADM][ADM] ", ln)]
    if d.targets:
        targets = [_expand(t, env) for t in d.targets]
        conflicts = [
            ln
            for ln in conflicts
            if any(ln[3:] == t or ln[3:].startswith(t + "/") for t in targets)
        ]
    if not conflicts:
        return None
    paths = "\n".join(f"  {ln[3:]}" for ln in conflicts)
    return Verdict(
        "deny",
        "chezmoi-apply-guard",
        "chezmoi apply would overwrite a file that something other than chezmoi wrote:\n\n"
        f"{paths}\n\n"
        "On this machine that usually means a parallel worktree job deployed a build there to "
        "test it, and the deployed bytes are the only copy — applying reverts its work "
        "mid-test. Read the change before deciding:\n\n"
        f"  chezmoi diff {conflicts[0][3:]}\n\n"
        "If the diff REMOVES things the source never had, another job owns that file — "
        "recover it from ~/.local/share/chezmoi/.claude/worktrees/*/ and leave it alone. If "
        f"the revert is what you actually want:\n\n  {override}",
    )


def post(command: str, env: Mapping[str, str], run: Runner = bounded.run) -> str | None:
    """What an `apply --source` left $HOME ahead of the primary checkout, as context.

    Deploying from a worktree is how unlanded config gets tested, and it leaves $HOME AHEAD
    of what the primary checkout can reproduce: the next plain apply reverts it. `chezmoi
    diff` against the default source shows exactly that (#583). Encrypted entries and scripts
    are excluded, since the diff renders both and this lands in the transcript. A diff that
    exits non-zero is a missed reminder, silent; one that did not finish is named, so its
    silence is not read as "nothing ahead". The bound is 10s.
    """
    if "chezmoi" not in command:
        return None
    czm = _chezmoi(env)
    if czm is None:
        return None
    d = decide(command)
    if not (d.writes and d.sourced):
        return None
    t = _timeout(env, 10)
    targets = [_expand(t, env) for t in d.targets]
    # A byte cap well past DIFF_LIMIT, so a cut-off diff still fills the excerpt.
    r = run([czm, "diff", "--no-pager", "--exclude=encrypted,scripts", *targets], t, 1048576, env)
    if r.status == "ok" and r.exit != 0:
        return None
    if r.status not in ("ok", "truncated"):
        return (
            f"chezmoi-apply-guard: `chezmoi diff` did not finish within {t}s ({r.status}) -- not "
            "evaluated, so it is unknown what this --source apply left ahead of the primary "
            "source checkout. Run `chezmoi diff` to see it."
        )
    diff = r.out
    if not diff:
        return None
    if len(diff) > DIFF_LIMIT:
        diff = (
            f"{diff[:DIFF_LIMIT]}\n[... truncated at {DIFF_LIMIT} of {len(diff)} characters; "
            "run `chezmoi diff` for the rest]"
        )
    return (
        "chezmoi-apply-guard: this --source apply left $HOME ahead of the primary source "
        "checkout. A plain `chezmoi apply` would undo the lines below (the diff runs from the "
        "deployed file to the primary source), so they stay unlanded until the branch lands:"
        f"\n\n{diff}"
    )
