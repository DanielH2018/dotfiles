"""Bash commands and Reads that cost context or a prompt: a one-line nudge, never a decision.

Four context-discipline rules are questions about command text. CLAUDE.md stated them
until the 2026-09-26 scaffolding pass cut the prose and left this module as their only
home. They ride on the PreToolUse pass this package already makes for every Bash call
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

A fifth rule is about a prompt, not context:

  5. show-substitution: `git show <rev>:$f` where the command holds a `$( )`, the shape
     of a loop over `git ls-tree` output. The judge refuses a substitution's output as
     a git argument (`substitution:consumer`), so each such loop costs a prompt.
     `git cat-file --batch` reads the same files with the names on stdin, which the
     judge admits. The rule fires on text alone, so `f=README.md` beside an unrelated
     `$( )` also trips it, which costs one line of advice once.

A sixth points at a better reader, the way python-json does:

  6. gitops-state: `cat`/`tail`/`head` of a file under `/var/lib/gitops-deploy/`, bare,
     under `sudo`, or inside an `ssh` remote command. The server repo's `probe.py
     gitops-state` prints every deployer marker and owed-ledger line with its clear
     command, and sessions drifted back to raw reads of `owed.jsonl` and `hold_sha`
     (dotfiles #1041).

A seventh reads the filesystem, which no other rule does:

  7. whole-file-cat: `cat` (any flags, `-n` included) of files totalling more than
     20 KB, with no bounding stage after it. A bounding stage is `head`, `tail`, `wc`,
     `grep`/`rg`/`ugrep` or `sed -n`. 20 KB is the `big_calls` cut-off `otelq savings
     bytes` uses, and `cat` produced 46 of the week's 218 calls over it (dotfiles
     #1076). A relative path resolves against the session cwd and any `cd` earlier in
     the command; a path that does not resolve to a regular file gets no nudge, and
     neither does a `cat` whose stdout goes to a redirect.

The Read tool's whole-file reads are the other half of that census, 70 of the 218 calls
(dotfiles #1085). A Bash hook never sees them, so `read_nudge()` judges a Read's
tool_input for the `read-nudge` hook entry instead:

  8. whole-file-read: a Read of a regular file over 20 KB with neither `offset` nor
     `limit`. An image or a PDF is skipped: the harness does not put its bytes into the
     context as text.

Two point at a wrapper where a deny would refuse legitimate calls (dotfiles #1223). Each
fires only where its wrapper is on PATH, since a host may have gh without either:

  9. gh-rerun-failed: `gh run rerun … --failed`. The wrapper refuses a repo the
     logged-in account does not own, and the command text does not name the owner, so a
     work-org rerun is left to run raw.
 10. runlog: a stage that sends stdout to a file and stderr after it (`> f 2>&1`, `&> f`),
     the hand-written capture `runlog` replaces. `/dev/null` is not a capture. ansible
     refuses the Bash tool's non-blocking stdio, which `runlog` swaps for blocking files.

One warns about a host tool, the way footguns.py's ugrep-flag rule does:

 11. ugrep-bounded-class: an extended-regex grep whose pattern bounds a negated class,
     such as `[^"]{0,200}`, where grep is ugrep. ugrep expands the class into every UTF-8
     byte sequence before it applies the bound. Two such classes with literals between
     them exceed its complexity limit: grep prints an error to stderr, exits 2 and
     matches nothing, so a `| wc -l` after it reads as zero (measured 2026-11-12, ugrep
     7.8.4). A single class often passes, so this is a nudge, not a deny. `-P` compiles
     the same pattern. The Bash tool's `grep` is Claude Code's shell-snapshot function,
     which runs the ugrep built into the claude binary even where PATH grep is GNU, so
     the rule asks whether that binary exists, not only what PATH grep is.

`nudge()` returns (rule, text) or None. The hook adds the text as additionalContext
beside whatever the deny rules decided, and only once per session per rule: `claim()`
creates a marker file for the (transcript, rule) pair with O_EXCL, and only the call that
creates it emits. Parallel tool calls in one turn run their hooks before the harness
writes any of their context to the transcript, so a scan of the transcript for the tag
lets each of them nudge. A command the segmenter cannot read gets no nudge.
"""

import hashlib
import os
import re
import shlex
import shutil
import time
from pathlib import Path

from claude_guard.footguns import _grep_is_ugrep, _short_flags
from claude_guard.segment import parse

_COUNT_FLAG = re.compile(r"^-(?:\d+|n\d*|-max-count(?:=.*)?|-since=.*|-after=.*)$")
_PYTHON = re.compile(r"^python(?:3(?:\.\d+)?)?$")
# A `<rev>:<path>` word whose path part expands something: `origin/main:$f`.
_REV_PATH_EXPANSION = re.compile(r"^[^-$:][^:]*:.*\$")
_CONTROL_WORDS = frozenset({"do", "then", "else", "{", "!"})
_GITOPS_DIR = "/var/lib/gitops-deploy/"
_RAW_READERS = frozenset({"cat", "tail", "head"})
# Matches otelq's BIG_RESULT_BYTES, the cut-off of its `big_calls` census.
_BIG_CAT_BYTES = 20_000
_BOUNDING_READERS = frozenset({"head", "tail", "wc", "grep", "rg", "ugrep"})
# A word that sends stdout to a file: `>f`, `>>f`, `1>f`, `&>f`, or `a>f` glued to an
# operand. `2>/dev/null` and `2>&1` leave stdout on the context.
_STDOUT_REDIRECT = re.compile(r"(?:^1|^|[^0-9])>")
# A redirect operator standing alone as a word, its target in the next word: `2>`, `<`.
_REDIRECT_OPERATOR = re.compile(r"^(?:\d*|&)(?:<|>>?)&?$")
# Stdin read from a file, which `cat` then prints: `<`, `0<`, or `<f` glued to its target.
# `<<` and `<<<` are a heredoc and a herestring, not a file.
_STDIN_FROM = re.compile(r"^0?<(?![<&])(.*)$")
# A word that sends stdout to a file, with its target glued on or in the next word.
_STDOUT_TO = re.compile(r"^(?:1?>>?|&>>?)(.*)$")
# A bounded negated class: `[^"]{0,80}` in ERE, `[^"]\{0,80\}` in BRE.
# The class may open with a literal `]` and hold POSIX classes such as `[:space:]`.
_NEGATED_CLASS = r"\[\^\]?(?:\[:[a-z]+:\]|[^\]])*\]"
_BOUNDED_NEGATED_ERE = re.compile(_NEGATED_CLASS + r"\{\d*,?\d*\}")
_BOUNDED_NEGATED_BRE = re.compile(_NEGATED_CLASS + r"\\\{\d*,?\d*\\\}")
# Read renders these as images or pages, not as text the size of the file.
_NON_TEXT_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"})


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
        "`jsonq` covers `python3 -c` over JSON without running arbitrary code. It is a "
        "closed Python subset with no attribute access: run `jsonq --functions` for the "
        "callable names."
    )


def _show_substitution(stages, i) -> str | None:
    stage = stages[i][0]
    # A loop body or branch arrives as its own segment with the keyword still on it.
    while stage and stage[0] in _CONTROL_WORDS:
        stage = stage[1:]
    if stage[:1] != ["git"] or "show" not in stage[1:]:
        return None
    rest = stage[stage.index("show") + 1 :]
    if not any(_REV_PATH_EXPANSION.match(w) for w in rest):
        return None
    if not any("$(" in w for words, _ in stages for w in words):
        return None
    return (
        "`git show <rev>:$f` over a name from a `$( )` costs a permission prompt: "
        "claude-guard never lets a substitution's output into a git argument. Send the "
        "names on stdin instead, which needs no prompt: `git ls-tree -r --name-only <rev> "
        "<dir> | sed 's|.*|<rev>:& &|' | git cat-file --batch='== %(rest)'` prints each "
        "file under an `== <path>` line. A path holding a space breaks that label; use "
        "plain `--batch` then."
    )


def _gitops_state(stages, i) -> str | None:
    words = []
    # An ssh remote command arrives as one quoted word: split it to see its reader.
    for w in stages[i][0]:
        try:
            words.extend(shlex.split(w) if " " in w else [w])
        except ValueError:
            words.append(w)
    if not any(_GITOPS_DIR in w for w in words):
        return None
    if not any(w.rsplit("/", 1)[-1] in _RAW_READERS for w in words):
        return None
    return (
        "This reads the GitOps deployer's state raw. In the server repo, "
        "`uv run python scripts/diagnostics/probe.py gitops-state` prints every marker "
        "and owed-ledger line with the command that clears it (`--json` for the raw form)."
    )


def _bounded_by_next(stages, i) -> bool:
    """Whether stage `i` pipes into a stage that bounds what reaches the context."""
    if not _piped(stages, i) or i + 1 >= len(stages):
        return False
    consumer = stages[i + 1][0]
    if consumer[0] in _BOUNDING_READERS:
        return True
    return consumer[0] == "sed" and "-n" in consumer[1:]


def _cwd_at(stages, i, cwd: str) -> str:
    """The directory stage `i` runs in: the session cwd moved by each earlier `cd`, or
    "" once a `cd` goes somewhere this cannot follow (`cd -`, bare `cd`, an expansion)."""
    for words, _ in stages[:i]:
        if words[0] != "cd":
            continue
        args = [w for w in words[1:] if not w.startswith("-")]
        if len(args) != 1 or "$" in args[0]:
            return ""
        target = os.path.expanduser(args[0])
        if not os.path.isabs(target):
            if not cwd:
                return ""
            target = os.path.join(cwd, target)
        cwd = target
    return cwd


def _whole_file_cat(stages, i, cwd: str) -> str | None:
    stage = stages[i][0]
    while stage and stage[0] in _CONTROL_WORDS:
        stage = stage[1:]
    if stage[:1] != ["cat"]:
        return None
    if any(_STDOUT_REDIRECT.search(w) for w in stage[1:]):
        return None
    if _bounded_by_next(stages, i):
        return None
    files = []
    words = iter(stage[1:])
    for w in words:
        stdin = _STDIN_FROM.match(w)
        if stdin:
            # `cat < big.j2` prints big.j2 as surely as `cat big.j2` does.
            target = stdin.group(1) or next(words, None)
            if target:
                files.append(target)
        elif _REDIRECT_OPERATOR.match(w):
            # `2> err.log`: the word after a spaced operator is its target, not an operand.
            next(words, None)
        elif not w.startswith("-") and "<" not in w and ">" not in w:
            files.append(w)
    if not files:
        return None
    base = _cwd_at(stages, i, cwd)
    total = 0
    for name in files:
        path = os.path.expanduser(name)
        if not os.path.isabs(path):
            if not base:
                return None
            path = os.path.join(base, path)
        if not os.path.isfile(path):
            return None
        total += os.path.getsize(path)
    if total <= _BIG_CAT_BYTES:
        return None
    return (
        f"This `cat` puts {total // 1000} KB into the context, where it stays for the rest "
        "of the session. Read the section you need: `rg -n <pattern> <file>` to find it, "
        "then `sed -n A,Bp <file>`, or the Read tool with `offset`/`limit`."
    )


def _gh_rerun_failed(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[:3] != ["gh", "run", "rerun"] or "--failed" not in stage:
        return None
    if not shutil.which("gh-rerun-failed"):
        return None
    return (
        "In a repo you own, `gh-rerun-failed <run-id> [-R owner/repo]` re-runs the failed "
        "jobs without a prompt; it needs the sandbox off. It refuses a repo owned by "
        "anyone else, such as a work org, so there `gh run rerun --failed` is the one to run."
    )


def _runlog(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[0] == "runlog" or not shutil.which("runlog"):
        return None
    target, merged = None, False
    words = iter(stage[1:])
    for w in words:
        if w in ("2>&1", "&>", "&>>") or w.startswith("&>"):
            merged = True
        m = _STDOUT_TO.match(w)
        if m:
            target = m.group(1) or next(words, None)
    if not merged or not target or target == "/dev/null":
        return None
    return (
        "To capture a command's output to a file, `runlog <name> -- <command> [args…]` "
        "writes stdout and stderr to a log it names, then prints the path, the tail and "
        "the exit code. It gives the command blocking stdio and `/dev/null` as stdin."
    )


def _bash_tool_grep_is_ugrep() -> bool:
    """Whether `grep` typed in the Bash tool runs ugrep, which PATH alone does not decide.

    Claude Code's shell snapshot defines `grep` as a function that runs the ugrep built
    into its own binary, `$CLAUDE_CODE_EXECPATH` or else `~/.local/bin/claude`, and falls
    back to PATH grep only when neither is executable. This mirrors that fallback.
    """
    binary = os.environ.get("CLAUDE_CODE_EXECPATH", "")
    if not os.access(binary, os.X_OK):
        binary = str(Path.home() / ".local/bin/claude")
    return os.access(binary, os.X_OK) or _grep_is_ugrep()


def _ugrep_bounded_class(stages, i) -> str | None:
    stage = stages[i][0]
    if stage[0] not in ("grep", "egrep", "ugrep"):
        return None
    flags = _short_flags(stage)
    if "P" in flags or "--perl-regexp" in stage:
        return None
    extended = stage[0] != "grep" or "E" in flags or "--extended-regexp" in stage
    bounded = _BOUNDED_NEGATED_ERE if extended else _BOUNDED_NEGATED_BRE
    if not any(bounded.search(w) for w in stage[1:]):
        return None
    if stage[0] == "grep" and not _bash_tool_grep_is_ugrep():
        return None
    if stage[0] == "egrep" and not _grep_is_ugrep():
        return None
    return (
        "The Bash tool's grep is ugrep, which can refuse a bounded negated class such as "
        '`[^"]{0,200}` with "exceeds complexity limits". It then exits 2 and matches '
        "nothing, so a count after it reads as zero. Use `grep -P` for the same pattern, "
        "or drop the bound."
    )


_RULES = (
    ("unbounded-log", _unbounded_log),
    ("recursive-ls", _recursive_ls),
    ("transcript-grep", _transcript_grep),
    ("python-json", _python_json),
    ("show-substitution", _show_substitution),
    ("gitops-state", _gitops_state),
    ("gh-rerun-failed", _gh_rerun_failed),
    ("runlog", _runlog),
    ("ugrep-bounded-class", _ugrep_bounded_class),
)


def tag(rule: str) -> str:
    return f"[claude-guard:nudge:{rule}]"


def nudge(command: str, cwd: str = "") -> tuple[str, str] | None:
    """(rule, tagged text) for the first rule `command` trips, or None. `cwd` is the
    session's working directory; without it a relative path never trips whole-file-cat."""
    stages = _stages(command) or []
    rules = (*_RULES, ("whole-file-cat", lambda s, i: _whole_file_cat(s, i, cwd)))
    for i in range(len(stages)):
        for rule, check in rules:
            found = check(stages, i)
            if found:
                return rule, f"{tag(rule)} {found}"
    return None


def read_nudge(tool_input: dict, cwd: str = "") -> tuple[str, str] | None:
    """(rule, tagged text) when a Read's `tool_input` reads a big file whole, or None.

    A relative `file_path` resolves against `cwd`, and without one it is left alone.
    """
    name = tool_input.get("file_path")
    if not isinstance(name, str) or not name:
        return None
    if tool_input.get("offset") is not None or tool_input.get("limit") is not None:
        return None
    path = os.path.expanduser(name)
    if not os.path.isabs(path):
        if not cwd:
            return None
        path = os.path.join(cwd, path)
    if os.path.splitext(path)[1].lower() in _NON_TEXT_SUFFIXES or not os.path.isfile(path):
        return None
    size = os.path.getsize(path)
    if size <= _BIG_CAT_BYTES:
        return None
    rule = "whole-file-read"
    return rule, (
        f"{tag(rule)} This Read puts {size // 1000} KB into the context, where it stays for "
        "the rest of the session. Find the section first with `rg -n <pattern> <file>`, then "
        "Read it with `offset` and `limit`."
    )


# A marker older than this is pruned; a session resumed after it may see a nudge again.
_MARKER_MAX_AGE_S = 7 * 24 * 3600


def _marker_dir() -> Path:
    home = os.environ.get("HOME") or os.path.expanduser("~")
    return Path(home) / ".cache" / "claude-guard" / "nudged"


def claim(transcript_path: str, rule: str) -> bool:
    """Whether this call is the first in the session to nudge `rule`, recording that it is.

    The session is the transcript that records the caller's context. Without one, or when
    the marker cannot be written, the answer is True: the nudge is one line of context, so
    repeating it is cheaper than losing it.
    """
    if not transcript_path:
        return True
    key = hashlib.sha256(transcript_path.encode()).hexdigest()[:24]
    d = _marker_dir()
    try:
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(d / f"{key}-{rule}", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    except OSError:
        return True
    os.close(fd)
    now = time.time()
    for old in d.iterdir():
        try:
            if now - old.stat().st_mtime > _MARKER_MAX_AGE_S:
                old.unlink()
        except OSError:
            pass
    return True
