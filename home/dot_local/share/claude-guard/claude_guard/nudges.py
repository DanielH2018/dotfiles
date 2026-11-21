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

A sixth reads the filesystem, which no other rule does:

  6. whole-file-cat: `cat` (any flags, `-n` included) of files totalling more than
     20 KB, with no bounding stage after it. A bounding stage is `head`, `tail`, `wc`,
     `grep`/`rg`/`ugrep` or `sed -n`. 20 KB is the `big_calls` cut-off `otelq savings
     bytes` uses, and `cat` produced 46 of the week's 218 calls over it (dotfiles
     #1076). A relative path resolves against the session cwd and any `cd` earlier in
     the command; a path that does not resolve to a regular file gets no nudge, and
     neither does a `cat` whose stdout goes to a redirect.

Two point at a wrapper where a deny would refuse legitimate calls (dotfiles #1223). Each
fires only where its wrapper is on PATH, since a host may have gh without either:

  7. gh-rerun-failed: `gh run rerun … --failed`. The wrapper refuses a repo the
     logged-in account does not own, and the command text does not name the owner, so a
     work-org rerun is left to run raw.
  8. runlog: a stage that sends stdout to a file and stderr after it (`> f 2>&1`, `&> f`),
     the hand-written capture `runlog` replaces. `/dev/null` is not a capture. `runlog`
     swaps the Bash tool's non-blocking stdio for blocking files, which some CLIs refuse.

One warns about a host tool, the way footguns.py's ugrep-flag rule does:

  9. ugrep-bounded-class: an extended-regex grep whose pattern bounds a negated class,
     such as `[^"]{0,200}`, where grep is ugrep. ugrep expands the class into every UTF-8
     byte sequence before it applies the bound. Two such classes with literals between
     them exceed its complexity limit: grep prints an error to stderr, exits 2 and
     matches nothing, so a `| wc -l` after it reads as zero (measured 2026-11-12, ugrep
     7.8.4). A single class often passes, so this is a nudge, not a deny. `-P` compiles
     the same pattern. The Bash tool's `grep` is Claude Code's shell-snapshot function,
     which runs the ugrep built into the claude binary even where PATH grep is GNU, so
     the rule asks whether that binary exists, not only what PATH grep is.

Seven point a raw state question at the reader that already answers it (dotfiles
#1391). Transcript mining over the 14 days to 2026-11-15 found sessions running the raw
command instead. `_READERS` holds them as one table, a row per pair, so the next
pair is one more row:

  landed-check: `ghread pr list --head B`, or `git log origin/master..B` for any B but
    HEAD, asking whether B has landed. `prune-worktrees.py --check B` answers that and
    sees a squash merge, which an ancestry check misses.
  landing-inflight: `ps` or `pgrep` in a command that names `land.sh` -> `probe.py landing`.
  landing-verdicts: `tail` of a file whose name holds `land`, or of an absolute path whose
    first line is `land`'s own, as a backgrounded run's output file is ->
    `probe.py landing-verdicts`.
  flux-state: `kubectl get kustomization`, bare or inside an `ssh` remote command ->
    `probe.py flux`.
  pi-containers: `ssh daniel-pi docker ps|inspect` -> `probe.py pi`.
  gh-quota: `ghread api rate_limit` -> `gh-quota status`.
  unit-state: a local `systemctl show -p` -> `unitq show`.

A row whose reader is a server-repo script fires only when the stage's directory sits
inside a checkout that holds the script, the way rules 8 and 9 fire only where their
wrapper is on PATH. The other two rows need their tool on PATH. The text matchers misfire
sometimes, such as on a `tail` of `island.txt`, which costs one line once per session.

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
from itertools import pairwise
from pathlib import Path

from claude_guard.footguns import _grep_is_ugrep, _short_flags
from claude_guard.segment import parse

_COUNT_FLAG = re.compile(r"^-(?:\d+|n\d*|-max-count(?:=.*)?|-since=.*|-after=.*)$")
_PYTHON = re.compile(r"^python(?:3(?:\.\d+)?)?$")
# A `<rev>:<path>` word whose path part expands something: `origin/main:$f`.
_REV_PATH_EXPANSION = re.compile(r"^[^-$:][^:]*:.*\$")
_CONTROL_WORDS = frozenset({"do", "then", "else", "{", "!"})
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
# `origin/master..B` for a branch B other than HEAD: "has B landed?".
_LANDED_RANGE = re.compile(r"^origin/(?:master|main)\.\.(?!HEAD$)[^.\s]\S*$")
# The first line `land` prints, which opens a backgrounded run's task-id-named output file:
# `land --detach: running in background`, `land: 3 landings are already live`.
_LAND_FIRST_LINE = re.compile(rb"land(?: --[a-z-]+)*: ")


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


def _bounded_by_next(stages, i) -> bool:
    """Whether stage `i` pipes into a stage that bounds what reaches the context."""
    if not _piped(stages, i) or i + 1 >= len(stages):
        return False
    consumer = stages[i + 1][0]
    if consumer[0] in _BOUNDING_READERS:
        return True
    return consumer[0] == "sed" and "-n" in consumer[1:]


def _cwd_at(stages, i, cwd: str | None) -> str | None:
    """The directory stage `i` runs in: the session cwd moved by each earlier `cd`, or
    None once a `cd` goes somewhere this cannot follow (`cd -`, bare `cd`, an expansion)."""
    for words, _ in stages[:i]:
        if words[0] != "cd":
            continue
        args = [w for w in words[1:] if not w.startswith("-")]
        if len(args) != 1 or "$" in args[0]:
            return None
        target = os.path.expanduser(args[0])
        if not os.path.isabs(target):
            if cwd is None:
                return None
            target = os.path.join(cwd, target)
        cwd = target
    return cwd


def _whole_file_cat(stages, i, cwd: str | None) -> str | None:
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
            if base is None:
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


def _words(stages, i) -> list[str]:
    """Stage `i`'s words with a leading control word or `sudo` dropped, and each quoted word
    that holds a space split, so an `ssh` remote command shows its own words."""
    stage = stages[i][0]
    while stage and (stage[0] in _CONTROL_WORDS or stage[0] == "sudo"):
        stage = stage[1:]
    words = []
    for w in stage:
        try:
            words.extend(shlex.split(w) if " " in w else [w])
        except ValueError:
            words.append(w)
    return words


def _asks_if_landed(stages, i) -> bool:
    words = _words(stages, i)
    if words[:3] == ["ghread", "pr", "list"]:
        return any(w == "--head" or w.startswith("--head=") for w in words)
    return words[:1] == ["git"] and "log" in words and any(_LANDED_RANGE.match(w) for w in words)


def _looks_for_landing(stages, i) -> bool:
    if _words(stages, i)[:1] not in (["ps"], ["pgrep"]):
        return False
    return any("land.sh" in w for words, _ in stages for w in words)


def _is_landing_output(name: str) -> bool:
    """Whether `name` is a landing log by its name, or a file whose first line is `land`'s."""
    path = Path(name).expanduser()
    if "land" in path.name:
        return True
    # A FIFO or device blocks open(), which would stall the hook past its timeout.
    if not path.is_absolute() or not path.is_file():
        return False
    try:
        with path.open("rb") as f:
            head = f.read(256)
    except OSError:
        return False
    return bool(_LAND_FIRST_LINE.match(head))


def _tails_landing_log(stages, i) -> bool:
    words = _words(stages, i)
    if words[:1] != ["tail"]:
        return False
    return any(not w.startswith("-") and _is_landing_output(w) for w in words[1:])


def _gets_kustomizations(stages, i) -> bool:
    words = _words(stages, i)
    if "kubectl" not in words:
        return False
    rest = words[words.index("kubectl") + 1 :]
    if "get" not in rest:
        return False
    kinds = (k for w in rest[rest.index("get") + 1 :] for k in w.split(","))
    return any(k == "ks" or k.startswith("kustomization") for k in kinds)


def _reads_pi_containers(stages, i) -> bool:
    words = _words(stages, i)
    if words[:1] != ["ssh"] or not any(w.split("@")[-1] == "daniel-pi" for w in words):
        return False
    return any(w == "docker" and nxt in ("ps", "inspect") for w, nxt in pairwise(words))


def _reads_rate_limit(stages, i) -> bool:
    words = _words(stages, i)
    return words[:2] == ["ghread", "api"] and any(w.strip("/") == "rate_limit" for w in words[2:])


def _shows_unit_property(stages, i) -> bool:
    words = _words(stages, i)
    if words[:1] != ["systemctl"] or "show" not in words:
        return False
    return any(w in ("-p", "--property") or w.startswith(("-p", "--property=")) for w in words)


def _in_server_checkout(script: str):
    """A gate that holds when the stage runs inside a checkout holding `script`."""

    def gate(stages, i, cwd: str | None) -> bool:
        base = _cwd_at(stages, i, cwd)
        if base is None:
            return False
        here = Path(base)
        return any((d / script).is_file() for d in (here, *here.parents))

    return gate


def _on_path(tool: str):
    return lambda stages, i, cwd: bool(shutil.which(tool))


_PROBE = "scripts/diagnostics/probe.py"

# (rule, matcher, gate, text): the raw command, where its reader exists, and the pointer.
_READERS = (
    (
        "landed-check",
        _asks_if_landed,
        _in_server_checkout(_PROBE),
        "To ask whether branch B has landed, run `~/.claude/hooks/prune-worktrees.py --check "
        "B`. It sees a squash merge, which `git log origin/master..B` and a PR list miss.",
    ),
    (
        "landing-inflight",
        _looks_for_landing,
        _in_server_checkout(_PROBE),
        "`uv run python scripts/diagnostics/probe.py landing` lists the landing runs in "
        "flight, read from deploy-ui's `/api/inflight`, without a process scan.",
    ),
    (
        "landing-verdicts",
        _tails_landing_log,
        _in_server_checkout(_PROBE),
        "`uv run python scripts/diagnostics/probe.py landing-verdicts` prints each landing's "
        "verdict, so a `land.sh` output file need not be tailed.",
    ),
    (
        "flux-state",
        _gets_kustomizations,
        _in_server_checkout(_PROBE),
        "`uv run python scripts/diagnostics/probe.py flux` reports the Flux kustomizations' state.",
    ),
    (
        "pi-containers",
        _reads_pi_containers,
        _in_server_checkout(_PROBE),
        "`uv run python scripts/diagnostics/probe.py pi` reports daniel-pi's containers "
        "without an ssh round trip per question.",
    ),
    (
        "gh-quota",
        _reads_rate_limit,
        _on_path("gh-quota"),
        "`gh-quota status` prints GitHub API spend per session in the open quota windows, "
        "beside GitHub's own count, and spends no API call to do it.",
    ),
    (
        "unit-state",
        _shows_unit_property,
        _on_path("unitq"),
        "`unitq show [--user] <unit> <Property>...` prints the named properties as "
        "`PROP=value`, with any secret in them removed.",
    ),
)


def _reader_check(match, gate, text):
    return lambda stages, i, cwd: text if gate(stages, i, cwd) and match(stages, i) else None


# Every check takes (stages, i, cwd); only whole-file-cat and the reader rows read cwd.
_RULES = (
    *(
        (rule, lambda stages, i, cwd, check=check: check(stages, i))
        for rule, check in (
            ("unbounded-log", _unbounded_log),
            ("recursive-ls", _recursive_ls),
            ("transcript-grep", _transcript_grep),
            ("python-json", _python_json),
            ("show-substitution", _show_substitution),
            ("gh-rerun-failed", _gh_rerun_failed),
            ("runlog", _runlog),
            ("ugrep-bounded-class", _ugrep_bounded_class),
        )
    ),
    ("whole-file-cat", _whole_file_cat),
    *((rule, _reader_check(match, gate, text)) for rule, match, gate, text in _READERS),
)


def tag(rule: str) -> str:
    return f"[claude-guard:nudge:{rule}]"


def nudge(command: str, cwd: str | None = None) -> tuple[str, str] | None:
    """(rule, tagged text) for the first rule `command` trips, or None. `cwd` is the
    session's working directory; without it a relative path never trips whole-file-cat and
    no rule whose reader lives in a server checkout fires."""
    stages = _stages(command) or []
    for i in range(len(stages)):
        for rule, check in _RULES:
            found = check(stages, i, cwd)
            if found:
                return rule, f"{tag(rule)} {found}"
    return None


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
