"""A Bash write that leaves a worktree-isolated session's worktree (server#1419, server#2818).

`isolation-guard.sh` denies an Edit or Write that lands in a git checkout outside
`.claude/worktrees/`, but it matches `Edit|Write|NotebookEdit` only. Auto mode tells the model
to make file changes with sed, heredocs or short scripts instead, so the Bash surface was the
uncovered one. Measured 2026-09-06 18:17:54 in the server repo: a worktree-isolated agent ran
`cd /home/ubuntu/server && python3 - <<'EOF' ... EOF`, the heredoc wrote to the PRIMARY
checkout, and nothing stopped it. The stray edit left that tree dirty, which parked the GitOps
deployer, and the agent's own verification grep ran under the same `cd` and read the escaped
copy back, so the failure was silent from the inside.

This lived in the server repo's `block-protected-bash.py` as its arm 3 until server#2818 moved
it here. Nothing in it is specific to that repo: it reads the session's cwd, the
`.claude/worktrees/` marker and the segmenter, so it belongs in the guard every repo runs.

Scope: a session whose cwd is itself under `.claude/worktrees/`. Outside one this check is
inert, so an ordinary session in a primary checkout is untouched.

Two decisions. A real escape is a `deny`. Text the segmenter refuses (an unbalanced quote, an
unclosed substitution) is an `ask` carrying the reason, but only when the text has a write
shape at all: the package's contract is that a non-ok parse is never read as "nothing here",
and a deny on a typo would put the strongest decision on the weakest evidence.

DECIDED: a deny, not an ask, for a real escape. A heuristic that wrongly asks costs a prompt,
but a write outside an isolated session's worktree is never the right call: a wrong deny costs
one re-run from the right directory, while a wrong allow can dirty a checkout every other
session reads. The known cost is that a deliberate edit to another checkout from a worktree
session is denied; the reason string names the way through.
"""

import os
import re

from claude_guard.segment import parse

# The marker isolation-guard.sh uses, spelled with separators on both sides so a directory
# merely NAMED worktrees does not match.
_WORKTREES = f"{os.sep}.claude{os.sep}worktrees{os.sep}"

# The shapes a model's file write takes. Deliberately not a shell parser: a write inside
# `python3 -c` or a called script is invisible in the command text and is not detected. Each
# pattern captures the path in group 1.
_WRITE_SHAPES = (
    # `> path`, `>> path`: the redirect, by far the most common.
    re.compile(r">>?\s*([^\s;&|<>()]+)"),
    # `tee path`, `tee -a path`: a pipe's write end.
    re.compile(r"\btee\s+(?:-[^\s]+\s+)*([^\s;&|<>()]+)"),
    # `sed -i … path`, `perl -pi -e … path`: in-place editors, target last.
    re.compile(r"\b(?:sed|perl)\b[^;&|]*?\s-[A-Za-z]*i(?:\.[^\s]*)?\s[^;&|]*?([^\s;&|<>()]+)\s*$"),
)

# Command words that take a heredoc and then write files the command text never names. This is
# the incident's own shape: `python3 - <<'EOF'` carries no redirect, so `written_paths` returns
# nothing and there is no target to judge, only the directory the write lands in. `uv` is here
# because `uv run python - <<EOF` is how a uv project invokes its pinned interpreter.
HEREDOC_INTERPRETERS = frozenset(
    {"python", "python3", "bash", "sh", "zsh", "perl", "ruby", "node", "uv"}
)

_CD = re.compile(r"^\s*(?:cd|pushd)\s+([^\s;&|<>()]+)\s*$")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def written_paths(command: str) -> list[str]:
    """Candidate paths `command` writes to. Best-effort, biased toward missing one."""
    found = []
    for line in command.splitlines():
        for shape in _WRITE_SHAPES:
            found.extend(m.group(1) for m in shape.finditer(line))
    # A heredoc delimiter and a process substitution are not paths; neither is a bare `-`.
    return [p for p in found if p != "-" and not p.startswith(("$", "<", "("))]


def _in_a_worktree(path: str) -> bool:
    return _WORKTREES in os.path.abspath(path) + os.sep


def _inside_a_git_checkout(path: str) -> bool:
    """True if `path` sits under a directory holding a `.git`.

    Pure filesystem, no subprocess: this runs in front of every Bash call. A path outside any
    repo (/tmp, a scratch directory, ~/.claude/artifacts) is not a checkout edit and is left
    alone, the same scope isolation-guard.sh states.
    """
    current = os.path.abspath(path)
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def _escapes(path: str) -> bool:
    """True if a write to `path` lands in a git checkout outside any `.claude/worktrees/`."""
    return not _in_a_worktree(path) and _inside_a_git_checkout(path)


def _heredoc_interpreter(segment: str) -> str | None:
    """The interpreter this segment feeds a heredoc to, or None."""
    if "<<" not in segment:
        return None
    for token in segment.split():
        if _ENV_ASSIGN.match(token):
            continue
        word = os.path.basename(token)
        return word if word in HEREDOC_INTERPRETERS else None
    return None


def verdict(command: str, cwd: str) -> tuple[str, str] | None:
    """("deny" | "ask", reason) for a write outside the isolated worktree, or None.

    Walks the command a segment at a time, carrying the directory a leading `cd` or `pushd`
    moves it to. That carry is the whole point: the incident's relative writes were only
    outside the worktree by virtue of the `cd` in front of them. The segmenter splits on
    unquoted separators only, so `echo 'x; cd /primary'` is not read as a `cd` the shell never
    performs, and it lifts heredoc bodies off the segment text, so a Markdown `>` in prose is
    not read as a redirect.

    Per segment, a write that names targets is judged on its targets, so `cd /primary && cat
    foo > /tmp/x` stays clean. Only a writer that names nothing (an interpreter fed a heredoc)
    is judged on the directory it runs in.

    Args:
      command: the raw Bash text from the hook payload.
      cwd: the session's working directory; "" or a path outside `.claude/worktrees/` makes
        this check inert.
    """
    if not cwd or not _in_a_worktree(cwd):
        return None
    parsed = parse(command)
    if not parsed.ok:
        if "<<" not in command and not written_paths(command):
            return None
        return (
            "ask",
            f"This session is isolated in {cwd}, and the worktree-escape guard cannot read "
            f"this command ({parsed.status}), so it cannot tell where the write lands. Fix "
            f"the quoting, or confirm the write stays inside the worktree.",
        )
    here = os.path.abspath(cwd)
    for segment in (seg.text for seg in parsed.segments):
        if not segment.strip():
            continue
        moved = _CD.match(segment)
        if moved:
            destination = moved.group(1).strip("\"'")
            if "$" in destination or destination == "-":
                # An unresolvable destination: every later segment's directory is unknown, so
                # stop rather than judge against a directory the command is not in.
                return None
            here = os.path.abspath(os.path.join(here, os.path.expanduser(destination)))
            continue
        targets = [p.strip("\"'") for p in written_paths(segment)]
        if targets:
            for target in targets:
                resolved = target if os.path.isabs(target) else os.path.join(here, target)
                if _escapes(resolved):
                    return (
                        "deny",
                        f"`{os.path.abspath(resolved)}` is in a git checkout outside "
                        f"`.claude/worktrees/`, and this session is isolated in {cwd}. Write "
                        f"inside the worktree instead. If the edit genuinely belongs to "
                        f"another checkout, make it from a session that is not "
                        f"worktree-isolated.",
                    )
            continue
        interpreter = _heredoc_interpreter(segment)
        if interpreter and _escapes(here):
            return (
                "deny",
                f"This command runs `{interpreter}` on a heredoc from {here}, a git checkout "
                f"outside `.claude/worktrees/`, while this session is isolated in {cwd}. The "
                f"heredoc names no target, so the directory it runs in decides where its "
                f"writes land. Drop the `cd` and write inside the worktree.",
            )
    return None
