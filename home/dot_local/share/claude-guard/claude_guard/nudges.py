"""Bash commands that work but flood the context: a one-line nudge, never a decision.

Four CLAUDE.md "Tool use & context discipline" rules are questions about command text,
so they ride on the PreToolUse pass this package already makes for every Bash call
rather than on a process of their own (reprime-nudge.sh, the per-event shape dotfiles
#586 pointed at, was retired in #652 for costing a process per event):

  1. unbounded-log: `git log` with no count and no range, whose output goes straight
     to the context rather than into a pipe. A long history lands there whole.
  2. recursive-ls: `ls -R` whose output goes straight to the context.
  3. transcript-grep: a grep/rg over transcript JSONL (a `.jsonl` argument or a path
     under `.claude/projects`) with no `cut` stage. `head -n` bounds lines, not
     bytes, and a transcript line can be tens of KB.
  4. python-json: `python3 -c` whose code mentions json, where `jsonq` does the job
     without the permission prompt `python3 -c` costs.

`nudge()` returns (rule, text) or None. The hook adds the text as additionalContext
beside whatever the deny rules decided, and only once per session per rule: the text
carries the tag `[claude-guard:nudge:<rule>]`, the harness records additionalContext in
the transcript, and a transcript that already holds the tag means the session has seen
it. A command the segmenter cannot read gets no nudge.
"""

import re
import shlex

from claude_guard.segment import parse

_COUNT_FLAG = re.compile(r"^-(?:\d+|n\d*|-max-count(?:=.*)?|-since=.*|-after=.*)$")
_PYTHON = re.compile(r"^python(?:3(?:\.\d+)?)?$")


def _stages(command: str) -> list[tuple[list[str], str]] | None:
    """Each stage's shlex words and the separator that ends it, or None if unreadable."""
    parsed = parse(command)
    if not parsed.ok:
        return None
    stages = []
    for segment in parsed.segments:
        try:
            words = shlex.split(segment.text)
        except ValueError:
            return None
        if words:
            stages.append((words, segment.sep))
    return stages


def _piped(stages, i) -> bool:
    """Whether stage `i` feeds a pipe rather than the context. Any consumer counts:
    `git log | grep amend` is the author already narrowing the output."""
    return stages[i][1] == "|"


def _unbounded_log(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[0] != "git" or "log" not in stage[1:]:
        return None
    rest = stage[stage.index("log") + 1 :]
    if any(_COUNT_FLAG.match(w) for w in rest) or any(".." in w for w in rest):
        return None
    if "--since" in rest or "--after" in rest or "--max-count" in rest:
        return None
    if _piped(stages, i):
        return None
    return (
        "`git log` with no count flows the whole history into the context. Bound it "
        "at the source: `git log -n 20 --oneline`, a range such as `origin/main..HEAD`, "
        "or a `| head` stage."
    )


def _recursive_ls(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[0] != "ls":
        return None
    short = "".join(w[1:] for w in stage[1:] if w.startswith("-") and not w.startswith("--"))
    if "R" not in short and "--recursive" not in stage:
        return None
    if _piped(stages, i):
        return None
    return (
        "`ls -R` lists every file below the directory into the context. Bound it: "
        "`| head -50`, `| wc -l`, or `find <dir> -maxdepth 2`."
    )


def _transcript_grep(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[0] not in ("grep", "rg", "ugrep"):
        return None
    if not any(w.endswith(".jsonl") or ".claude/projects" in w for w in stage[1:]):
        return None
    if any(words[0] == "cut" for words, _ in stages):
        return None
    return (
        "This greps transcript JSONL. A transcript line can be tens of KB, so `head -n` "
        "bounds nothing. Add `| cut -c1-200` (or grep -o a bounded pattern)."
    )


def _python_json(stages, i) -> str | None:
    stage = stages[i][0]
    if not _PYTHON.match(stage[0]) or "-c" not in stage:
        return None
    at = stage.index("-c")
    code = stage[at + 1] if at + 1 < len(stage) else ""
    if "json" not in code:
        return None
    return (
        "`python3 -c` over JSON costs a permission prompt; `jsonq` is allowlisted and "
        "covers it. It is a closed Python subset with no attribute access: run "
        "`jsonq --functions` for the callable names."
    )


_RULES = (
    ("unbounded-log", _unbounded_log),
    ("recursive-ls", _recursive_ls),
    ("transcript-grep", _transcript_grep),
    ("python-json", _python_json),
)


def tag(rule: str) -> str:
    return f"[claude-guard:nudge:{rule}]"


def nudge(command: str) -> tuple[str, str] | None:
    """(rule, tagged text) for the first rule `command` trips, or None."""
    stages = _stages(command) or []
    for i in range(len(stages)):
        for rule, check in _RULES:
            found = check(stages, i)
            if found:
                return rule, f"{tag(rule)} {found}"
    return None


def seen(transcript_path: str, rule: str) -> bool:
    """Whether the session transcript already carries this rule's nudge.

    An unreadable or absent transcript reads as not seen: the nudge is one line of
    context, so repeating it is cheaper than losing it.
    """
    if not transcript_path:
        return False
    needle = tag(rule).encode()
    try:
        with open(transcript_path, "rb") as handle:
            return any(needle in line for line in handle)
    except OSError:
        return False
