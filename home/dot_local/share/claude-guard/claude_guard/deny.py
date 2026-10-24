"""block-dangerous-bash.sh, ported rule for rule.

Every function below cites the line range of home/private_dot_claude/hooks/
executable_block-dangerous-bash.sh it reproduces (`:NNN`), and every message is the bash's,
verbatim: the harness shows the deny reason to the model, so a changed message is a changed
behaviour.

Three subjects, as the bash has them (:238-317):

    scan     SCAN — the whole command normalised: escaped separators dropped, quoted
             separators dropped unless a re-parse vector is present, newline/tab/backslash
             collapsed to a space, quote characters removed. Heredoc bodies are IN it.
    scanset  BDB_SCANSET — SCAN, then one normalised line per segment.parse segment and per
             substitution body. The command-position-anchored families read this, so a
             command after a newline is in command position.
    segset   BDB_SEGSET — the same set without SCAN, for the pair rules that need both halves
             from ONE command. When the parse refuses, both collapse to SCAN alone, which is
             the bash's degradation path: a refusal lands on the whole-string rules, never on
             nothing (:313-317). This is the ONE place the package's "a refusal is never a
             skip" contract reads differently, and it is deliberate: the bash does not ask on
             an unbalanced quote (tests/hooks/block-dangerous-bash-normalization.test.js,
             "a command cmd_parse refuses still gets the whole-string rules"), and this slice
             is a port.

Rules that read the raw command (`sc.command`) rather than SCAN do so because the bash does
(`bdb_re "$COMMAND"`): the substitution-download, fork-bomb, kill-by-substitution, disk-wipe
and protected-file-write arms.

The regexes are the bash's EREs with two textual substitutions (`_ere`): `[:space:]` → `\\s`
and `[:alnum:]` → `a-zA-Z0-9`, both inside bracket expressions where Python has no POSIX
classes. `\\b` and `\\s` are the same GNU extensions in both engines. ERE's leftmost-longest
rule and Python's leftmost-first differ only in WHICH match is chosen, never in whether one
exists, and every use here is a boolean search. SECRET_PATHS is the one exception: its
`.env` branch carries a Python lookahead that has no ERE form (#861).

Two rules are not the bash's. `sudo_boundary` is new (dotfiles #863): it refuses sudo at any
command position except one wrapper line, on every host. The other: the bash upgraded a
`--force`/`-f` push to a feature branch into `--force-with-lease` and allowed it;
`force_push_flag` denies it instead (dotfiles #701), so this hook and the settings deny
rules state one intent.

Two rules have changed since the bash in ways that reach their messages. `pipe_to_shell`
judges each pipeline stage rather than the whole string, so a `|sh` quoted in an argument
that no stage runs as shell is allowed, and its message names an alternative (dotfiles
#801). `secret_readers` drops exclude arguments before it matches, and both secret-read
denials name the words that matched, with the exclude arguments for a recursive search
(dotfiles #802).
"""

import fnmatch
import io
import itertools
import posixpath
import re
import shlex
import tokenize
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from claude_guard import secret_table
from claude_guard.gitargv import (
    GLOBALS_RE,
    PUSH_SUBCOMMANDS,
    Invocation,
    canonical_lines,
    config_writes,
    invocations,
    remote_add_mirrors_push,
    subcommand_at,
)
from claude_guard.gitread import config_read
from claude_guard.inert_python import inert
from claude_guard.segment import Segment, mask_substitutions, parse


@dataclass(frozen=True, slots=True)
class Verdict:
    kind: str  # "deny" | "ask" | "allow" | "none"
    rule: str  # a fixed literal, never text from the command
    reason: str  # the message the bash prints; "" for allow and none


NONE = Verdict("none", "", "")


# --- the matchers (:74-106, :326-335) --------------------------------------------------------


def _ere(pattern: str) -> str:
    return pattern.replace("[:space:]", r"\s").replace("[:alnum:]", "a-zA-Z0-9")


_compiled: dict[tuple[str, bool], re.Pattern[str]] = {}


def _pattern(pattern: str, icase: bool) -> re.Pattern[str]:
    key = (pattern, icase)
    p = _compiled.get(key)
    if p is None:
        p = re.compile(_ere(pattern), re.IGNORECASE if icase else 0)
        _compiled[key] = p
    return p


def bdb_re(subject: str, pattern: str, icase: bool = False) -> bool:
    """:74-94. grep is LINE-oriented: `^`/`$` anchor at every line and no match crosses a
    newline. The bash loop splits on newlines to reproduce that; so does this."""
    p = _pattern(pattern, icase)
    return any(p.search(line) for line in subject.split("\n"))


def bdb_rei(subject: str, pattern: str) -> bool:
    """:98-106, the `grep -qiE` arm."""
    return bdb_re(subject, pattern, icase=True)


def bdb_re_pair(lines: str, re1: str, re2: str) -> bool:
    """:326-335. Both patterns must match the SAME member of the set."""
    return any(bdb_re(line, re1) and bdb_re(line, re2) for line in lines.split("\n"))


# --- normalisation (:108-236) ----------------------------------------------------------------

# :211. Whole-string, not per line — the bash tests it with a bare [[ =~ ]].
_REPARSE = re.compile(
    _ere(
        r"(\$\(|`|<\(|>\(|<<|(^|[^[:alnum:]_])(eval|exec|source|xargs|env|sudo|doas|nohup|"
        r"timeout|watch|nice|parallel|make|find|ssh|hl|scp|sh|bash|zsh|ksh|dash|csh|tcsh|fish|"
        r"ash|mksh|pdksh|yash|osh|xonsh|elvish|nu|python|python2|python3|perl|ruby|node|deno|"
        r"bun|lua|php|tclsh|Rscript|julia|expect|osascript|awk|gawk|mawk|busybox)"
        r"([^[:alnum:]_]|$))"
    )
)


def _drop_quoted_separators(s: str) -> str | None:
    """:155-177. Delete `;` `&` `|` that sit inside a quoted region. Returns None when a quote
    is unbalanced — nothing can be proven, so the caller keeps the string untouched. A
    backslash outside single quotes escapes the next character; inside them it escapes
    nothing."""
    out: list[str] = []
    last = 0
    q = ""
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\":
            i += 1 if q == "'" else 2
            continue
        if c in "\"'":
            if q == "":
                q = c
            elif q == c:
                q = ""
            i += 1
            continue
        if c in ";&|" and q != "":
            out.append(s[last:i])
            last = i + 1
        i += 1
    if q:
        return None
    out.append(s[last:])
    return "".join(out)


def normalize(s: str) -> str:
    """:216-236. `\\\\` becomes two spaces FIRST so an escaped backslash cannot pair with the
    separator after it (:124-130); then the escaped separators go; then, when the string has
    a quote and names no re-parse vector, the quoted separators go; then newline, tab and
    backslash collapse to a space and the quote characters are deleted."""
    s = s.replace("\\\\", "  ")
    s = s.replace("\\|", "").replace("\\;", "").replace("\\&", "")
    if ('"' in s or "'" in s) and not _REPARSE.search(s):
        dropped = _drop_quoted_separators(s)
        if dropped is not None:
            s = dropped
    s = s.replace("\n", " ").replace("\t", " ").replace("\\", " ")
    return s.replace('"', "").replace("'", "")


# --- the scan set (:238-317) -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Scan:
    command: str
    scan: str
    scanset: str
    segset: str
    parsed: bool
    # Every git invocation the parsed segments run, read by claude_guard.gitargv (#709).
    gits: tuple[Invocation, ...] = ()
    # Each physical line of the command, normalized on its own. `normalize` joins lines with
    # a space, which hides a command that starts a line: a heredoc body that runs
    # `sops -d …`, or one that follows a newline. The decrypt rules read this too (#861).
    lines: str = ""


def build_scan(command: str) -> Scan:
    scan = normalize(command)
    lines = "\n".join(normalize(line) for line in command.split("\n"))
    p = parse(command)
    if not p.ok:
        return Scan(command, scan, scan, scan, False, lines=lines)
    texts = [seg.text for seg in p.segments] + list(p.substitutions)
    members = [normalize(text) for text in texts]
    # Not the bash's (#709): one more member per git push a segment runs, spelled
    # `git push <args>` with git's global options dropped and an inline alias expanded, so the
    # push rules' `git push` anchor matches `git -C "<dir with a space>" push -f` too.
    members += [
        normalize(line) for text in texts for line in canonical_lines(text, PUSH_SUBCOMMANDS)
    ]
    gits = tuple(inv for text in texts for inv in invocations(text))
    scanset = "\n".join([scan, *members])
    segset = "\n".join(members) if members else scan
    return Scan(command, scan, scanset, segset, True, gits, lines)


# --- shared anchors (:368, :383-384, :591-599) ------------------------------------------------

SSH_AT_RE = (
    r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|"
    r"(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?(ssh|hl)([[:space:]]|$)"
)
TF_BIN = r"(terraform|tofu|terragrunt)"
TF_AT = r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*"
HOME_TAIL = r"/?(\s|\*|\)|`|$)"


def rm_target(home: str) -> str:
    """:591-599. Root, root-with-glob, `~`, `$HOME`, and the home path written out."""
    parts = [rf"\s/{HOME_TAIL}", rf"\s~{HOME_TAIL}", rf"\s\$HOME{HOME_TAIL}"]
    if home:
        parts.append(rf"\s{re.escape(home)}{HOME_TAIL}")
    return "(" + "|".join(parts) + ")"


Rule = Callable[[Scan, str], "Verdict | None"]


# --- remote re-scan (:613-659) ------------------------------------------------------------------

SSH_HINT = (
    "Run privileged or destructive remote commands in a direct session on the server, "
    "not from an agent session."
)
_RM_RF_FLAGS = r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b.*"


def remote(sc: Scan, target: str) -> Verdict | None:
    """:625-659. The gate reads the scan set; the payload scan stays WHOLE-STRING (:629-642,
    measured: narrowing it removes denies and gains nothing). All six arms fold case."""
    if not bdb_rei(sc.scanset, SSH_AT_RE):
        return None
    arms = (
        ("remote-sudo", r"\bsudo\b", "Blocked: sudo inside a remote (ssh/hl) command."),
        (
            "remote-su",
            r"(^|[;&|(`]|[[:space:]])[[:space:]]*su[[:space:]]+(-|root|[a-z_])",
            "Blocked: su inside a remote (ssh/hl) command.",
        ),
        (
            "remote-rm-root",
            _RM_RF_FLAGS + target,
            "Blocked: rm -rf of home/root on the remote host.",
        ),
        ("remote-chown", r"\bchown\b", "Blocked: chown inside a remote (ssh/hl) command."),
        (
            "remote-chmod-777",
            r"\bchmod\s+(-[a-zA-Z]*\s+)*0?777\b",
            "Blocked: chmod 777 inside a remote (ssh/hl) command.",
        ),
        (
            "remote-power",
            r"\b(reboot|poweroff|halt|shutdown)\b|\binit\s+[06]\b",
            "Blocked: power-state change (reboot/shutdown/halt) on the remote host.",
        ),
    )
    for rule, pattern, message in arms:
        if bdb_rei(sc.scan, pattern):
            return Verdict("deny", rule, f"{message} {SSH_HINT}")
    return None


# --- rm -rf on home or root (:661-667) -----------------------------------------------------

RM_MSG = "Blocked: rm -rf targeting home or root directory. Use a specific path instead."


# Commands whose quoted arguments are a pattern or a message that nothing runs.
_INERT_QUOTE_HEADS = frozenset({"grep", "egrep", "fgrep", "rg", "echo", "printf"})


def _inert_program(source: str | None, expands: bool) -> bool:
    """Whether `source`, a closed-shape Python program (`_python_source`), starts no process.
    When the shell expands the program first (`expands`: a `-c` argument, or a heredoc whose
    delimiter is unquoted), a `$` or a backtick in it can run a command before Python reads
    a word, so such a program is never inert."""
    if source is None or (expands and ("$" in source or "`" in source)):
        return False
    return inert(source)


def _heredoc_program_expands(source: str | None, heredocs: tuple[str, ...], quoted) -> bool:
    """Whether the shell expands `source` before Python reads it: True unless `source` is one
    of `heredocs` and that heredoc's delimiter is quoted (`<<'EOF'`)."""
    return not any(body == source and q for body, q in zip(heredocs, quoted, strict=False))


def _rm_members(sc: Scan) -> list[str]:
    """The texts `rm_root` matches: each segment, substitution and heredoc body on its own.

    Matching the joined SCAN paired `rm -rf /tmp/x` in one segment with the ` / ` of a later
    `sed 's/^/--role /'`. Three things are left out. A heredoc body that is only stored
    (`_without_stored_heredocs`). The program of a closed-shape Python segment that starts no
    process (`_inert_program`). And a grep, echo or printf segment whose `rm` sits only
    inside quotes. The last two are dropped only when no segment of the command runs code,
    since `echo 'rm -rf ~' > x.sh; bash x.sh` runs what the first segment only names. A
    command the parser refuses is matched whole, as before."""
    sc = _without_stored_heredocs(sc)
    p = parse(sc.command)
    if not p.ok:
        return [sc.scan]
    runs_code = any(_runs_code(s.text) for s in p.segments)
    members: list[str] = []
    for seg in p.segments:
        words = _words(seg.text) or []
        argv = _argv(words)
        source = _python_source(words, seg.heredocs) if words else None
        expands = _heredoc_program_expands(source, seg.heredocs, seg.heredoc_quoted)
        inert_source = _inert_program(source, expands)
        bare = _unquoted(seg.text)
        quoted_only = (
            not runs_code
            and bool(argv)
            and posixpath.basename(argv[0]) in _INERT_QUOTE_HEADS
            and bare is not None
            and not re.search(r"\brm\b", bare)
        )
        if not quoted_only and not (inert_source and source in seg.text):
            members.append(normalize(seg.text))
        members += [normalize(b) for b in seg.heredocs if not (inert_source and b == source)]
    members += [normalize(s) for s in p.substitutions]
    return members


def rm_root(sc: Scan, target: str) -> Verdict | None:
    """:662-667. Joined flags first, then the separated spelling (rm -r -f, --recursive
    --force); the target check on the second arm is case-SENSITIVE (bdb_re), as the bash.
    Both arms read one member at a time (`_rm_members`)."""
    members = _rm_members(sc)
    if any(bdb_rei(m, _RM_RF_FLAGS + target) for m in members):
        return Verdict("deny", "rm-root", RM_MSG)
    if any(
        bdb_rei(m, r"\brm\s")
        and bdb_rei(m, r"(\s-[a-zA-Z]*r|\s--recursive)")
        and bdb_rei(m, r"(\s-[a-zA-Z]*f|\s--force)")
        and bdb_re(m, target)
        for m in members
    ):
        return Verdict("deny", "rm-root-split-flags", RM_MSG)
    return None


# --- git push (:669-728) ---------------------------------------------------------------------

_FORCE_WORD = r"(--force([ ]|$)|[ ]-f([ ]|$))"
_FORCE_FLAG = rf"git\s+push.*{_FORCE_WORD}"
_LEASE = r"\-\-force-with-lease"
_MAIN_DEST_F = r"(^|[[:space:]]|:)(main|master)([[:space:]]|:|\)|`|$)"

# Not the bash's (#709): git, any run of git's global options, then a push, for text the
# canonical `git push` lines do not cover (a refused parse, `bash -c '...'`). An inline alias
# whose value pushes counts as the push. Each rule below matches its flag or destination
# AFTER this anchor in one regex, never as a pair over the whole member, so a global option's
# value (`git -C main push origin feat`) is not read as a destination.
GIT_PUSH_AT = (
    rf"(?:{subcommand_at(PUSH_SUBCOMMANDS)}|"
    r"git\s[^;&|]*?\s-c\s+alias\.[^\s=]+=!?[^;&|]*?\b(?:push|send-pack|http-push)\b)"
)
_FORCE_MAIN_AT = rf"{GIT_PUSH_AT}(?=.*{_FORCE_WORD})(?=.*{_MAIN_DEST_F})"
_REFSPEC_MAIN = r".*\+\s*(main|master|refs/heads/(main|master))\b"


def force_push(sc: Scan, target: str) -> Verdict | None:
    """:687-693. The push and its destination must share a segment (bdb_re_pair); the
    --force-with-lease exemption stays whole-string."""
    if not bdb_re(sc.scan, _LEASE) and (
        bdb_re_pair(sc.segset, _FORCE_FLAG, _MAIN_DEST_F) or bdb_re(sc.segset, _FORCE_MAIN_AT)
    ):
        return Verdict(
            "deny", "force-push-main", "Blocked: force-push to main/master. Use a feature branch."
        )
    if bdb_re(sc.scan, rf"git\s+push{_REFSPEC_MAIN}") or bdb_re(
        sc.segset, rf"{GIT_PUSH_AT}{_REFSPEC_MAIN}"
    ):
        return Verdict(
            "deny",
            "force-push-refspec",
            "Blocked: force-push via +refspec to main/master. Use a feature branch.",
        )
    return None


def push_main(sc: Scan, target: str) -> Verdict | None:
    """:725-728. Any push whose DESTINATION is main/master; `:` is deliberately not a
    terminator here so `main:feature` stays a push to feature."""
    dest = r"([[:space:]]|:)(refs/heads/)?(main|master)([[:space:]]|\)|`|$)"
    if bdb_re_pair(sc.segset, r"git[[:space:]]+push\b", dest) or bdb_re(
        sc.segset, rf"{GIT_PUSH_AT}.*{dest}"
    ):
        return Verdict(
            "deny",
            "push-main",
            "Blocked: push targeting main/master. Push a feature branch and open a PR.",
        )
    return None


# --- gh api (:730-766) -------------------------------------------------------------------------

_GH_API_WORDS = (
    r"[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|"
    r"(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?gh[[:space:]]+api\b"
)
GH_API_AT = rf"(^|[;&|(`]){_GH_API_WORDS}"
GH_HINT = "Read-only requests need no prompt; approve this if the mutation is intended."
GH_SECRET_HINT = (
    "It also names a secrets path, so it is denied rather than offered: `gh` is absent "
    "from READERS, which leaves this rule the only gate on that path."
)


def gh_api(sc: Scan, target: str) -> Verdict | None:
    """:745-766. Gate on the scan set or a heredoc a shell runs; the arms read only the
    texts that run gh api (`_gh_api_texts`), or SCAN when the parser refuses the command.
    The method arm folds case.

    A possible mutation is an ask rather than a deny: the caller is usually posting a review
    reply or editing a PR, and a prompt is the right gate for that. A command naming a
    secrets path stays a deny. `gh` is absent from READERS and this rule runs ahead of
    secret_readers, so first-match-wins leaves it the only gate on a request body read out
    of `~/.ssh/id_rsa`; an ask there would downgrade a hard stop to one approval."""
    texts = _gh_api_texts(sc)
    runs_gh = texts is not None and any(bdb_re(normalize(t), GH_API_AT) for t in texts)
    if not (bdb_re(sc.scanset, GH_API_AT) or runs_gh):
        return None
    secret = bdb_re(sc.scan, SECRET_PATHS)

    def gate(rule: str, message: str) -> Verdict:
        if secret:
            return Verdict("deny", rule + "-secret", message + " " + GH_SECRET_HINT)
        return Verdict("ask", rule, message + " " + GH_HINT)

    subject = sc.scan if texts is None else "\n".join(map(normalize, texts))
    if bdb_rei(
        subject,
        r"(^|[[:space:]])(-X|--method)[[:space:]]*=?[[:space:]]*(POST|PUT|PATCH|DELETE)\b",
    ):
        return gate(
            "gh-api-method",
            "Mutating request (POST/PUT/PATCH/DELETE).",
        )
    arms = (
        (
            "gh-api-field-long",
            r"(^|[[:space:]])(--field|--raw-field)([[:space:]]|=)",
            "Field parameter, which makes the request a POST.",
        ),
        (
            "gh-api-field-short",
            r"(^|[[:space:]])-[a-zA-Z]*[fF]",
            "Field parameter (-f/-F), which makes the request a POST.",
        ),
        (
            "gh-api-input",
            r"(^|[[:space:]])--input([[:space:]]|=)",
            "Request body read from a file.",
        ),
    )
    for rule, pattern, message in arms:
        if bdb_re(subject, pattern):
            return gate(rule, message)
    graphql = (
        bdb_re(subject, r"(^|[[:space:]]|/)graphql\b")
        if texts is None
        else any(_GH_GRAPHQL.fullmatch(e) for t in texts for e in _gh_api_endpoints(t))
    )
    if graphql:
        return gate("gh-api-graphql", "A graphql request, which can mutate.")
    return None


# gh api's options that take the next word as their value: a jq filter or template can name
# `graphql` as a field, and a header or field value is not the endpoint either.
_GH_VALUE_OPTS = frozenset(
    {
        "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "-q", "--jq",
        "-t", "--template", "--hostname", "--input", "-p", "--preview", "--cache",
    }
)  # fmt: skip
_GH_GRAPHQL = re.compile(r"(.*/)?graphql")


def _gh_api_texts(sc: Scan) -> list[str] | None:
    """The texts the gh api arms read, or None when the parser refuses the command and the
    arms read SCAN whole. The texts are each segment and substitution that runs `gh api`,
    every heredoc body except one a data sink only stores (`_is_data_sink`), and each piece
    of SCAN, split on `;&|`, that starts with `gh api`. The SCAN pieces keep the whole-string
    arm: when a shell or interpreter sits anywhere in the command, SCAN keeps every quoted
    separator, so `python3 -c x; echo "c; gh api -XPOST …"` still asks. Another command's
    `-F` (`awk -F'\\t'`) and a commit message's `(gh api` are left out, since gh receives
    neither."""
    p = parse(sc.command)
    if not p.ok:
        return None
    start = _pattern(rf"^{_GH_API_WORDS}", False)
    found = [x for x in re.split(r"[;&|]", sc.scan) if start.search(x)]
    for seg in p.segments:
        runs_gh = bdb_re(normalize(seg.text), GH_API_AT)
        if runs_gh:
            found.append(seg.text)
        if runs_gh or not _is_data_sink(seg.text, seg.sep):
            found += [b for b in seg.heredocs if runs_gh or bdb_re(normalize(b), GH_API_AT)]
    found += [s for s in p.substitutions if bdb_re(normalize(s), GH_API_AT)]
    return found


def _gh_api_endpoints(text: str) -> list[str]:
    """The endpoint word of each `gh api` in `text`: the first word after `api` that is
    neither an option nor an option's value (`_GH_VALUE_OPTS`). `--jq '{core, graphql}'` on
    a REST call names no graphql endpoint. Text the word splitter refuses is split on
    whitespace instead."""
    words = _words(text) or text.split()
    found = []
    for i in range(len(words) - 1):
        if posixpath.basename(words[i]) != "gh" or words[i + 1] != "api":
            continue
        j = i + 2
        while j < len(words):
            if words[j] in _GH_VALUE_OPTS:
                j += 2
            elif words[j].startswith("-"):
                j += 1
            else:
                found.append(words[j])
                break
    return found


# --- pipes into an interpreter (:768-786, :849-852) -------------------------------------------

PIPE_WRAPPERS = (
    r"((sudo|env|command|exec|nohup|nice|stdbuf|xargs)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)*"
)
PIPE_TO_SHELL = (
    rf"\|[[:space:]]*{PIPE_WRAPPERS}([^[:space:]|;&]*/)?(sh|bash|zsh|dash|fish|ksh|ash)\b"
)
# :776-781: only a BARE interpreter — no script, no -c/-m — so stdin is the program.
PIPE_TO_INTERPRETER = (
    rf"\|[[:space:]]*{PIPE_WRAPPERS}([^[:space:]|;&]*/)?"
    r"(python[0-9.]*|node|deno|bun|perl|ruby|php)([[:space:]]+(-|/dev/stdin))?[[:space:]]*([;&|)]|$)"
)
DOWNLOAD_MSG = "Download, inspect, then run."


def curl_pipe(sc: Scan, target: str) -> Verdict | None:
    """:783-786."""
    if bdb_re(sc.scan, rf"(curl|wget)[^|]*({PIPE_TO_SHELL}|{PIPE_TO_INTERPRETER})"):
        return Verdict(
            "deny",
            "curl-pipe-interpreter",
            f"Blocked: piping remote content to an interpreter. {DOWNLOAD_MSG}",
        )
    return None


def substitution_download(sc: Scan, target: str) -> Verdict | None:
    """:788-806. Read on the RAW command: `bash <(curl …)`, `sh -c "$(wget …)"`, a backticked
    download, and the dot-source branch with its own backtick-safe anchor."""
    if bdb_re(
        sc.command,
        r"(\b(sh|bash|zsh|dash|fish|eval|source|python[0-9.]*|node|deno|bun|perl|ruby|php)\b|"
        r"(^|[;&|(`])[[:space:]]*\.[[:space:]])[^;&]*([<$]\(|`)[[:space:]]*([^[:space:]]*/)?"
        r"(curl|wget)\b",
    ):
        return Verdict(
            "deny",
            "substitution-download",
            "Blocked: executing downloaded content via process/command substitution. "
            f"{DOWNLOAD_MSG}",
        )
    return None


# Words that make a segment run its own quoted text as shell: `bash -c '… | sh'`,
# `ssh host '… | sh'`, awk's `print | "sh"`. `_REPARSE` is wider (python, xargs, `<<`), and
# reading it here denied `grep -E '(foo|sh)' f | xargs ls` (dotfiles #801). A word after a
# `.` is a file extension (`--include=*.sh`, `x.awk`), never a command, so it is left out.
_SHELL_REPARSE = re.compile(
    _ere(
        r"(^|[^[:alnum:]_.])(sh|bash|zsh|ksh|dash|csh|tcsh|fish|ash|mksh|pdksh|yash|osh|eval|"
        r"ssh|hl|su|watch|parallel|awk|gawk|mawk|busybox)([^[:alnum:]_]|$)"
    )
)


def _unquoted(s: str) -> str | None:
    """`s` with every quoted character blanked to a space, or None on an unbalanced quote.
    Escapes follow `_drop_quoted_separators`."""
    out: list[str] = []
    q = ""
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        step = (1 if q == "'" else 2) if c == "\\" else 1
        if c in "\"'":
            if q == "":
                q = c
            elif q == c:
                q = ""
            out.append(" ")
        else:
            out.append(" " * len(s[i : i + step]) if q else s[i : i + step])
        i += step
    return None if q else "".join(out)


# `segment.parse` returns a substitution body cut at its pipes, so a segment holding one is
# matched whole, as before #801.
_SUBSTITUTION = re.compile(r"\$\(|`|<\(|>\(")


_SCRIPT_PATH = re.compile(r"[\w.~/+-]*[\w~]")


def _runs_script_file(text: str) -> bool:
    """Whether the stage `text` is a bare shell running a script file it names, so the piped
    stdin is that script's data: `| bash /tmp/sz.sh`. Only `-e`, `-u`, `-x` and `-v` may come
    first, since `-c`, `-s`, `-i` and an option with a value (`-o pipefail`) leave stdin as
    the program. A script named by an expansion, `-` or `/dev/stdin` does not count, and
    neither does a shell behind a wrapper."""
    words = _words(text)
    argv = _argv(words) if words else []
    if not argv or posixpath.basename(argv[0]) not in _SHELLS:
        return False
    i = 1
    while i < len(argv) and re.fullmatch(r"-[euxv]+", argv[i]):
        i += 1
    return (
        i < len(argv)
        and _SCRIPT_PATH.fullmatch(argv[i]) is not None
        and not argv[i].startswith("-")
        and argv[i] != "/dev/stdin"
    )


def _pipes_to_shell(command: str) -> bool:
    """Whether some pipeline stage of `command` is a shell. A stage is matched on its own
    normalised text, so a `|sh` quoted inside another stage's argument is not a pipe. A
    segment that re-parses its quoted text (`_SHELL_REPARSE`) or holds a substitution is
    matched whole, with its heredoc bodies; a heredoc fed to anything else is data. A command
    the parse refuses falls back to the whole-string match.

    A stage after a pipe is a shell only when its command word is one, so the match is
    anchored at the stage's start: `| grep -E '\\.(py|sh|md)'` names `sh` in a pattern. A
    stage that may run code keeps the unanchored match, since a quoted `| sh` in
    `python3 -c "os.system('x | sh')"` runs. An escaped backtick is a literal character, not
    a substitution. When any segment runs code, a body a data sink stores is read too, as
    `_without_stored_heredocs` keeps it: `cat > x.sh <<'EOF' … EOF; bash x.sh` runs the body
    it stored."""
    p = parse(command)
    if not p.ok:
        return bdb_re(normalize(command), PIPE_TO_SHELL)
    runs_code = any(_runs_code(s.text) for s in p.segments)
    after_pipe = False
    for seg in p.segments:
        text = normalize(seg.text)
        stage = PIPE_TO_SHELL if _runs_code(seg.text) else "^" + PIPE_TO_SHELL
        if after_pipe and bdb_re("|" + text, stage) and not _runs_script_file(seg.text):
            return True
        bare = _unquoted(seg.text)
        whole = (
            bare is None
            or _SHELL_REPARSE.search(bare)
            or _SUBSTITUTION.search(seg.text.replace("\\`", ""))
        )
        if whole and bdb_re(text, PIPE_TO_SHELL):
            return True
        stored_then_run = runs_code and _is_data_sink(seg.text, seg.sep)
        if (whole or stored_then_run) and any(map(_pipes_to_shell, seg.heredocs)):
            return True
        after_pipe = seg.sep == "|"
    return False


def pipe_to_shell(sc: Scan, target: str) -> Verdict | None:
    """:849-852. The generic arm, after the kill rules, as in the bash. The whole-string match
    is a cheap gate; `_pipes_to_shell` then drops a quoted `|sh` that no stage runs (#801)."""
    if bdb_re(sc.scan, PIPE_TO_SHELL) and _pipes_to_shell(sc.command):
        return Verdict(
            "deny",
            "pipe-to-shell",
            f"Blocked: piping output to a shell interpreter. {DOWNLOAD_MSG} If the `|` and "
            "the shell name are only text inside a shell -c, ssh or awk argument, run the "
            "search with the Grep or Read tool, or from a tracked script, instead.",
        )
    return None


# --- protected writes, the fork bomb (:808-816) ----------------------------------------------


def write_secrets_file(sc: Scan, target: str) -> Verdict | None:
    """:809-811, raw command."""
    if bdb_re(sc.command, r">\s*(\.env|~?/\.ssh/|~?/\.aws/credentials)"):
        return Verdict(
            "deny",
            "write-secrets-file",
            "Blocked: writing to a secrets file. Ask the user to do this manually.",
        )
    return None


def fork_bomb(sc: Scan, target: str) -> Verdict | None:
    """:814-816, raw command."""
    if bdb_re(sc.command, r":\(\)\{.*\};:"):
        return Verdict("deny", "fork-bomb", "Blocked: fork bomb detected.")
    return None


# --- kill by pattern (:818-847) ------------------------------------------------------------------

KILL_HINT = (
    "Kill a PID you captured at spawn, or resolve one and confirm it first "
    "(ss -H -ltnp for a port owner, then check /proc/<pid>/cwd)."
)
KILL_AT = (
    r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|"
    r"(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?"
)
KILL_TAIL = r"([[:space:]]|\)|`|$)"


_PIPE_KILL = (
    r"\|[[:space:]]*([^[:space:]|;&]*/)?(xargs[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?"
    rf"kill{KILL_TAIL}"
)


def _pipes_to_kill(command: str, depth: int = 0) -> bool:
    """Whether a pipeline stage of `command` is kill, alone or behind xargs, as
    `_pipes_to_shell` reads a stage: `grep -E 'rollback|kill switch'` names `kill` inside a
    pattern. A segment that runs code or holds a substitution keeps the whole-string match on
    its own text, since `parse` cuts a substitution body at its pipes, and so does a heredoc
    body anything but a data sink takes. A command the parser refuses counts."""
    p = parse(command)
    if not p.ok or depth > 4:
        return True
    after_pipe = False
    for seg in p.segments:
        text = normalize(seg.text)
        if after_pipe and bdb_re("|" + text, "^" + _PIPE_KILL):
            return True
        whole = _runs_code(seg.text) or _SUBSTITUTION.search(seg.text.replace("\\`", ""))
        if whole and bdb_re(text, _PIPE_KILL):
            return True
        if not _is_data_sink(seg.text, seg.sep) and any(
            _pipes_to_kill(b, depth + 1) for b in seg.heredocs if bdb_re(normalize(b), _PIPE_KILL)
        ):
            return True
        after_pipe = seg.sep == "|"
    return any(bdb_re(normalize(s), _PIPE_KILL) for s in p.substitutions)


def kill_by_pattern(sc: Scan, target: str) -> Verdict | None:
    """:836-847. pkill/killall on the scan set; a pipe into kill on SCAN; kill of a
    substitution naming pgrep/ps on the raw command."""
    if bdb_re(sc.scanset, rf"{KILL_AT}(pkill|killall){KILL_TAIL}"):
        return Verdict(
            "deny",
            "pkill",
            "Blocked: pkill/killall selects processes by name or command line, which can "
            f"include this agent session. {KILL_HINT}",
        )
    if bdb_re(sc.scan, _PIPE_KILL) and _pipes_to_kill(sc.command):
        return Verdict("deny", "pipe-kill", f"Blocked: piping matched PIDs into kill. {KILL_HINT}")
    if bdb_re(sc.command, r"\bkill\b[^;&|]*([<$]\(|`)[^)`]*\b(pgrep|ps)\b"):
        return Verdict(
            "deny",
            "kill-pgrep",
            f"Blocked: kill of a PID found by pattern matching (pgrep/ps). {KILL_HINT}",
        )
    return None


# --- disk wipes (:854-857) -------------------------------------------------------------------


_DISK_WIPE = r"\b(mkfs|dd\s+if=.*of=/dev/|fdisk|parted)\b"


def disk_wipe(sc: Scan, target: str) -> Verdict | None:
    """:855-857, raw command, confirmed against the parse (`_runs_disk_tool`)."""
    if bdb_re(sc.command, _DISK_WIPE) and _runs_disk_tool(sc.command):
        return Verdict("deny", "disk-wipe", "Blocked: low-level disk operation.")
    return None


def _runs_disk_tool(command: str) -> bool:
    """Whether a match of `_DISK_WIPE` in `command` can run. A segment that only stores text
    or commits a message cannot: `git commit -m "… the two parted."` names `parted` as a
    word. Every other segment, substitution and heredoc body that matches counts, as does a
    command the parser refuses."""
    p = parse(command)
    if not p.ok:
        return True
    for seg in p.segments:
        words = _words(seg.text)
        argv = _argv(words) if words else []
        name = posixpath.basename(argv[0]) if argv else ""
        quiet = (
            name in ("echo", "printf")
            or _is_data_sink(seg.text, seg.sep)
            or (name == "git" and "commit" in argv)
        )
        if not quiet and bdb_re(seg.text, _DISK_WIPE):
            return True
        if not _is_data_sink(seg.text, seg.sep) and any(
            bdb_re(b, _DISK_WIPE) for b in seg.heredocs
        ):
            return True
    return any(bdb_re(s, _DISK_WIPE) for s in p.substitutions)


# --- secret reads (:859-949) -------------------------------------------------------------------

# :881. The four key/cert suffixes are anchored on BOTH sides so `.keys()` and a jq
# `\(.key)` do not read as a file (:866-880). DECIDED: the `.env` branch refuses the
# Python and Node environment accessors by name (#861): `os.environ`, `.environ.get` and
# `.environment` are code that names a process's environment, not a dotenv file, and they
# were most of 72 denials in three days of fan-out batches. The lookahead exempts only the
# exact words `environ`, `environment`, `environments` and `environb`, so `.env_production`,
# `.env2`, `.envfile`, `.envrc`, `.envs/` and `.environment_prod` are still refused. A jq
# filter's `.environments[]` (a GitHub API field) is why the plural is there. Node's
# `process.env` is the same accessor, exempted by the lookbehind. A JavaScript spread,
# `...env`, is a variable, not a path, so a `.env` after two more dots is exempt too; a
# path to a dotenv file puts `/` before the dot (`../.env`). A heredoc body is scanned
# unless `_without_stored_heredocs` finds it only stored, and a variable that names a
# credential is `secret_env`'s, since this branch no longer sees either accessor.
# DECIDED (2026-10-20, approved): the committed templates `.env.example`, `.env.sample` and
# `.env.template` hold placeholder keys, so the second lookahead exempts exactly those
# words. It applies only when no further path character follows, so `.env.example.local`,
# `.env.examples` and `.env.example/x` are still refused. A symlink named like a template
# is not resolved here; the sandbox resolves it and refuses a read that lands on a `.env`.
# DECIDED (2026-10-24, approved): a Jinja template named `<name>.env.j2` is tracked source
# that renders to an env file at deploy, so the third lookahead exempts it. The Read tool
# already allows it, since its globs only match a basename that starts with `.env`. A bare
# `.env.j2` keeps that rule's refusal, and so does the rendered `<name>.env`.
# The fragments come from the secret table (secret_paths.json, one entry per secret), which
# also feeds protect-secrets.sh and the settings Read()/Edit() denies. The `.env` fragment
# is the `dotenv` entry's. A missing or unreadable table raises here at import, and the
# PreToolUse shim answers a guard that cannot run with an ask, never an allow.
SECRET_PATHS = secret_table.deny_pattern()
# :884.
READERS = (
    r"(cat|tac|nl|head|tail|less|more|most|bat|batcat|strings|xxd|hexdump|hd|od|base32|base64|"
    r"uuencode|view|vi|vim|nvim|nano|emacs|ex|pico|grep|egrep|fgrep|rg|ag|ack|awk|gawk|mawk|sed|"
    r"gpg|openssl|shasum|md5|md5sum|sha1sum|sha256sum|cp|install|rsync|scp|truncate|dd|tar|jq|"
    r"yq|gojq|jaq)"
)
# :922.
ENV_DUMP = r"(^|[[:space:]])(env|printenv)([[:space:]]+-[^[:space:]]+)*[[:space:]]*$"
_DOC_LEADERS = frozenset(
    {"man", "which", "whereis", "type", "command", "echo", "printf", "apropos"}
)
_FILTERS = frozenset({"grep", "egrep", "fgrep", "rg", "ag", "ack", "jq", "yq", "gojq", "jaq"})
SECRET_READ_MSG = (
    "Blocked: reading a secrets file via bash. Use a non-sensitive path or ask the user to "
    "share the specific value needed."
)
ENV_DUMP_MSG = (
    "Blocked: a bare environment dump prints every exported credential. Name the variable "
    "you need, e.g. `printenv PATH`."
)
# An argument that keeps a path OUT of a search or copy reads nothing, so a secret path
# named in one is not a read (dotfiles #802): `--exclude=`, `--exclude-dir=`, rg's
# `--glob '!…'`, git's `:!…`, `:^…` and `:(exclude)…` pathspecs. Quotes are gone by now.
_EXCLUDE_WORD = re.compile(r"^(--exclude(-dir)?=|--i?glob=!|:(!|\^|\([^)]*exclude))")
_EXCLUDE_OPTS = frozenset({"--exclude", "--exclude-dir"})
_GLOB_OPTS = frozenset({"-g", "--glob", "--iglob"})
_RECURSIVE_GREP = re.compile(r"^(-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$")


def _drop_excludes(words: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else ""
        if _EXCLUDE_WORD.match(w):
            i += 1
        elif (w in _EXCLUDE_OPTS and nxt) or (w in _GLOB_OPTS and nxt.startswith("!")):
            i += 2
        else:
            out.append(w)
            i += 1
    return out


def _secret_words(words: list[str]) -> list[str]:
    """The words that match SECRET_PATHS, deduplicated, at most five."""
    p = _pattern(SECRET_PATHS, False)
    return list(dict.fromkeys(w for w in words if p.search(w)))[:5]


def _exclude_args(words: list[str], secrets: list[str]) -> list[str]:
    """The exclude arguments that keep each of `secrets` out of the search `words` runs:
    a recursive grep, rg or git grep. Empty for any other command."""
    head = words[0].rsplit("/", 1)[-1]
    if head in {"grep", "egrep", "fgrep"} and any(map(_RECURSIVE_GREP.match, words[1:])):
        tool = "grep"
    elif head == "rg":
        tool = "rg"
    elif head == "git" and "grep" in words[1:]:
        tool = "git"
    else:
        return []
    args: list[str] = []
    for w in secrets:
        # `--include=*.env` names the glob after the `=`.
        name = w.split("=", 1)[1] if w.startswith("-") and "=" in w else w
        is_dir = name.endswith("/")
        name = name.rstrip("/").rsplit("/", 1)[-1] or name
        if tool == "grep":
            args.append(f"--exclude{'-dir' if is_dir else ''}='{name}'")
        elif tool == "rg":
            args.append(f"--glob '!{name}'")
        else:
            args.append(f"':(exclude,glob)**/{name}{'/**' if is_dir else ''}'")
    return args


def _naming(secrets: list[str]) -> str:
    return f" The command names {', '.join(f'`{w}`' for w in secrets)}." if secrets else ""


# Commands that run code: an interpreter or shell, anything that execs its argv, and the
# task runners that execute a project's files. A command word computed at runtime (`$PY`)
# or given as a path (`./x.py`, `.venv/bin/python`) counts too, since it could be any of
# them.
_RUNNERS = frozenset(
    {
        "source",
        ".",
        "uv",
        "uvx",
        "npx",
        "pnpm",
        "yarn",
        "npm",
        "make",
        "just",
        "pytest",
        "tox",
        "nox",
        "ssh",
        "hl",
        "docker",
        "kubectl",
        "sudo",
        "doas",
        "pkexec",
        "su",
    }
)


def _words(text: str) -> list[str] | None:
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        return list(lex)
    except ValueError:
        return None


def _argv(words: list[str]) -> list[str]:
    i = 0
    while i < len(words) and (words[i] in _KEYWORDS or _ASSIGNMENT.match(words[i])):
        i += 1
    return words[i:]


def _runs_code(text: str) -> bool:
    """Whether the segment `text` may run code, so a file written earlier could execute."""
    words = _words(text)
    if words is None:
        return True
    argv = _argv(words)
    if not argv:
        return False
    head = argv[0]
    name = posixpath.basename(head)
    return (
        any(c in head for c in "$`/")
        or name in _RUNNERS
        or name in _INTERPRETERS
        or name in _SHELLS
        or name in _EXECUTORS
        or re.fullmatch(r"python[0-9.]*", name) is not None
    )


def _is_data_sink(text: str, sep: str) -> bool:
    """Whether the segment `text` stores its heredoc and runs nothing with it: `cat > f`,
    `tee f`, `git commit -F -` and `gh … --body-file -`. A segment piped onward is not one,
    because the next stage may be a shell."""
    words = _words(text)
    if words is None or sep == "|" or "|" in words:
        return False
    argv = _argv(words)
    if not argv:
        return False
    name = posixpath.basename(argv[0])
    pairs = set(zip(argv, argv[1:], strict=False))
    if name == "cat":
        return ">" in argv or ">>" in argv
    if name == "tee":
        return any(not w.startswith("-") for w in argv[1:])
    if name == "git" and ("commit" in argv or "tag" in argv):
        return (
            ("-F", "-") in pairs
            or ("--file", "-") in pairs
            or bool({"-F-", "--file=-"} & set(argv))
        )
    if name == "gh":
        return ("--body-file", "-") in pairs or ("-F", "-") in pairs or "--body-file=-" in argv
    return False


def _without_stored_heredocs(sc: Scan) -> Scan:
    """`sc` rebuilt without the heredoc bodies that are only stored: fed to a data sink, by a
    command where nothing runs code. Every other body stays in the scanned text.

    DECIDED: the secret-read rules skip such a body (#865 held off a wider exemption). What
    `cat > x.py <<EOF … EOF` writes can only reach a secret once something runs it, and a
    command that runs anything keeps every body here. A write in one call and a run in the
    next is the remaining gap, and the Write tool already opens it: a file it writes is never
    scanned at all. A body whose delimiter is unquoted expands `$(…)` while it is written, so
    that body is never skipped."""
    p = parse(sc.command)
    if not p.ok or p.substitutions or any(_runs_code(s.text) for s in p.segments):
        return sc
    command = sc.command
    for seg in p.segments:
        if not seg.heredocs or not _is_data_sink(seg.text, seg.sep):
            continue
        for body, quoted in zip(seg.heredocs, seg.heredoc_quoted, strict=True):
            if quoted or not any(m in body for m in ("$(", "`", "${")):
                # Removing the first copy is safe even when an identical text sits earlier
                # in the command: the copy left behind is the same text, still scanned.
                command = command.replace(body, "", 1)
    return sc if command == sc.command else build_scan(command)


# Words that open a compound command or a loop header ahead of the command a piece runs:
# `{ jq … f; }`, `( cat f )`, `! grep …`, `if cat f`, `for k in $(jq …)`.
_PIECE_LEADERS = frozenset({"{", "(", "!", "if", "then", "elif", "else", "do", "while", "until"})
_GLUED_OPENER = re.compile(r"^(\$\(|<\(|\(|`)+")


def _command_words(words: list[str]) -> list[str]:
    """`words` from the command a piece runs: compound-command openers, keywords and a
    `for NAME in` header skipped, and a `$(`, `<(`, `(` or backtick glued to the command
    word stripped. The command is what decides whether its first argument is a filter."""
    i = 0
    while i < len(words):
        if words[i] in _PIECE_LEADERS:
            i += 1
        elif words[i] == "for" and i + 2 < len(words) and words[i + 2] == "in":
            i += 3
        else:
            break
    rest = words[i:]
    if rest:
        head = _GLUED_OPENER.sub("", rest[0])
        rest = [head, *rest[1:]] if head else rest[1:]
    return rest


def _piece_read(piece: str) -> str | None:
    """The piece reduced to what `secret_readers` matches, if it reads a secret path: exclude
    arguments dropped, then for a filter command the pattern argument (:931-938)."""
    words = _command_words(piece.split())
    if not words:
        return None
    head = words[0].rsplit("/", 1)[-1]
    words = [words[0], *_drop_excludes(words[1:])]
    piece = " ".join(words)
    if head in _FILTERS:
        rest = words[1:]
        while rest:
            if not rest.pop(0).startswith("-"):
                break
        piece = f"{words[0]} {' '.join(rest)}"
    return piece if bdb_re(piece, rf"\b{READERS}\b.*{SECRET_PATHS}") else None


def _first_read(text: str) -> str | None:
    return next((x for x in re.split(r"[;&|]", normalize(text)) if _piece_read(x)), None)


_WRITE_REDIRECT = re.compile(r"[0-9]*(>|>>|>\||&>|&>>)")
# One sed `s` command and nothing else: a delimiter, a pattern, a replacement and only the
# flags that read and write no file (`w` writes one, `e` runs the pattern space, `r` is a
# separate command this shape cannot hold).
_SED_SUBST = re.compile(
    r"s(?P<d>[^\\\n])(\\.|(?!(?P=d)).)*(?P=d)(\\.|(?!(?P=d)).)*(?P=d)[gpiIM0-9]*"
)


def _read_head(text: str) -> str:
    """The words of the segment `text` as `_piece_read` should see them, rejoined. `normalize`
    splits a quoted grep pattern such as `'a\\|\\*\\*/.env'` into several words and keeps
    only the first one out of the match, so the pattern is blanked to `_` while its quotes
    are still known. A sed script that is one `s` command is blanked the same way, since it
    names no file. A write redirect's target is dropped, since `cat > x` reads nothing.
    Every other word is kept, with `;&|` turned to spaces so a quoted name cannot become a
    separator. Text the word splitter refuses, or that holds a substitution (shlex splits `$(`
    and `<(` into tokens of their own, which hides the command word), is returned
    unchanged."""
    words = None if any(m in text for m in ("$(", "<(", ">(", "`")) else _words(text)
    if words is None:
        return text
    kept: list[str] = []
    i = 0
    while i < len(words):
        if _WRITE_REDIRECT.fullmatch(words[i]):
            i += 2
            continue
        kept.append(words[i])
        i += 1
    cmd = _command_words(kept)
    if cmd:
        head = cmd[0].rsplit("/", 1)[-1]
        args = cmd[1:]
        if head in _FILTERS:
            j = next((k for k, w in enumerate(args) if not w.startswith("-")), None)
            if j is not None:
                args[j] = "_"
        elif head == "sed":
            args = ["_" if _SED_SUBST.fullmatch(w) else w for w in args]
        kept = [*kept[: len(kept) - len(cmd)], cmd[0], *args]
    return " ".join(re.sub(r"[;&|]", " ", w) for w in kept)


def _member_read(text: str, depth: int = 0) -> str | None:
    """The first piece of a quote-aware member of `text` that reads a secret path, or None.
    A member is a segment, a substitution body, or a heredoc body, each split and read the
    same way as SCAN. A segment's own words are read through `_read_head`. A segment carries
    its heredoc bodies, as it does in SCAN, so `cat > x.py <<'EOF'` stays a read of whatever
    the body names: the body is written for a later run, and the command may run it. A body
    is also parsed in turn, so `bash <<'EOF'` is judged on the commands it runs. Text the
    parser refuses is matched whole, as SCAN is."""
    p = parse(text)
    if not p.ok or depth > 4:
        return _first_read(text)
    segments = ("\n".join((_read_head(s.text), *s.heredocs)) for s in p.segments)
    for member in [*segments, *p.substitutions]:
        if hit := _first_read(member):
            return hit
    bodies = (body for s in p.segments for body in s.heredocs)
    return next((hit for body in bodies if (hit := _member_read(body, depth + 1))), None)


def secret_readers(sc: Scan, target: str) -> Verdict | None:
    """:893-944. SCAN split on every `;&|` character (a NAIVE split, deliberately: it is what
    catches a read hidden behind quoting), each piece word-split. The env-dump arm fires
    when the piece matches AND — if the parse succeeded — some quote-aware segment matches
    too (:911-921). Exclude arguments are dropped, then for a filter command the pattern
    argument (:931-938), before the readers arm. The denial names the words that matched,
    and for a recursive search the exclude arguments that would let it through (#802).

    The readers arm is confirmed the same way as the env-dump arm. SCAN joins lines with a
    space, so `cd "$S" || exit 1` and a jq on the next line share one piece whose head is
    `exit`, and the jq filter is matched as a path. When the parse succeeds, some
    segment, substitution or heredoc body must read a secret path too (`_member_read`),
    and the denial names what that piece reads."""
    sc = _without_stored_heredocs(sc)
    confirmed: str | None = None
    for piece in re.split(r"[;&|]", sc.scan):
        words = piece.split()
        if not words:
            continue
        head = words[0].rsplit("/", 1)[-1]
        # `| grep -n env` names `env` as a pattern; a filter prints no environment.
        if (
            head not in _DOC_LEADERS
            and head not in _FILTERS
            and bdb_re(piece, ENV_DUMP)
            and (not sc.parsed or bdb_re(sc.segset, ENV_DUMP))
        ):
            return Verdict("deny", "env-dump", ENV_DUMP_MSG)
        if _piece_read(piece) is None:
            continue
        if sc.parsed:
            if confirmed is None:
                confirmed = _member_read(sc.command) or ""
            piece = confirmed
        if read := _piece_read(piece):
            words = _command_words(piece.split())
            words = [words[0], *_drop_excludes(words[1:])]
            secrets = _secret_words(read.split()[1:])
            reason = SECRET_READ_MSG + _naming(secrets)
            if args := _exclude_args(words, secrets):
                reason += (
                    " To search a tree that holds them, replace each of those words with its "
                    f"parent directory and add {' '.join(args)}. The guard does not count an "
                    "exclude argument as a read."
                )
            return Verdict("deny", "secret-read", reason)
    return None


def secret_interpreter(sc: Scan, target: str) -> Verdict | None:
    """:945-949. The denial names the words that matched SECRET_PATHS (#802)."""
    sc = _without_python_attributes(_without_stored_heredocs(sc))
    if bdb_re(sc.scan, rf"{_INTERPRETER_WORD}.*{SECRET_PATHS}"):
        return Verdict(
            "deny",
            "secret-read-interpreter",
            "Blocked: reading a secrets file via an interpreter. Ask the user to share the "
            f"specific value needed.{_naming(_secret_words(sc.scan.split()))}",
        )
    return None


# DECIDED (dotfiles #957): a Python attribute access such as `self.env.filters`, `v.key)` or
# `pin.key,` is not a path, so `secret_interpreter` reads it with its dots turned to `_`. It
# does that only where the text is certainly Python source. Two narrowings that inferred
# which text was the program from the shell around it each failed open under review: a
# `python3` word that was a flag's value or another program's argument, a `-c` meant for a
# script, a heredoc fed to a script as data, a heredoc on fd 3. So the gate is a closed list
# of invocation shapes, `_python_source`, and every other shape keeps the plain scan, which
# refuses. A string literal is never masked: `open('server.key')` is how code opens a file
# (#864's DECIDED marker in tests/test_deny.py). A comment is not masked either.
#
# Residual: a `python3` or `.venv` interpreter planted earlier as a shell script runs the
# "Python" heredoc as shell. That is the scratch-script residual every text rule has; the
# guard never reads a file it did not see written.
_PY_FLAG = re.compile(r"-[IuBEsSqOP]+")
_PY_FLAG_THEN_C = re.compile(r"-[IuBEsSqOP]*c")
# Commands that may run before the masked Python segment. A segment that could change what
# the word `python3` runs, such as a function definition, an alias or a PATH assignment, is
# not one of these, so masking stops there.
_BEFORE_PYTHON = frozenset({"cd", "pwd", "true", "echo", "set"})
# Characters that `str.splitlines` or the tokenizer may treat as a line break while
# `io.StringIO` does not. A program holding one is not masked, so token columns are always
# read against the lines they were counted in.
_ODD_BREAKS = frozenset("\r\x0b\x0c\x1c\x1d\x1e\x85  ")


# The value-free `uv run` options seen before `python` in the 2026-10-17 to 2026-10-24
# replay (dotfiles #1000). None of them changes which interpreter runs or what it reads. An
# option that takes a value, such as `--with`, `--python` or `--project`, is left out: its
# value could be read as the program, and `--python` or `--project` can pick an interpreter
# planted earlier. `timeout <N>` and `.venv/bin/python` are left out for the same residual,
# and because neither appeared in a denial that week.
_UV_RUN_FLAGS = frozenset({"--frozen", "--no-project", "--offline", "--quiet", "-q"})
# A script path the shell passes as written: no expansion, no quote, no leading `-`.
_PY_SCRIPT = re.compile(r"[\w./][\w./-]*\.py")


def _past_uv_run(words: list[str]) -> list[str]:
    """`words` past a leading `uv run` and its value-free options (`_UV_RUN_FLAGS`)."""
    if words[:2] != ["uv", "run"]:
        return words
    i = 2
    while i < len(words) and words[i] in _UV_RUN_FLAGS:
        i += 1
    return words[i:]


def _python_source(words: list[str], heredocs: tuple[str, ...]) -> str | None:
    """The Python source of a segment whose words are one of the closed shapes, or None.

    The shapes are `python…` or `uv run python…` (`_past_uv_run`), then only value-free
    flags, then either `-c PROGRAM` or a program read from stdin (`-` or nothing) that is
    the segment's one heredoc on fd 0. Any leader, assignment, path-spelled interpreter,
    other flag, script, module, `<` redirect or fd-numbered heredoc returns None."""
    words = _past_uv_run(words)
    if not words or not re.fullmatch(r"python[0-9.]*", words[0]):
        return None
    i = 1
    while i < len(words) and _PY_FLAG.fullmatch(words[i]):
        i += 1
    rest = words[i:]
    if rest and _PY_FLAG_THEN_C.fullmatch(rest[0]):
        return rest[1] if len(rest) > 1 else None
    if rest and rest[0] == "-":
        rest = rest[1:]
    if not rest or rest[0] not in ("<<", "<<-") or len(heredocs) != 1:
        return None
    if sum("<" in w for w in words) != 1:
        return None
    return heredocs[0]


def _script_arguments_start(argv: list[str]) -> int | None:
    """The index in `argv` of the first argument a Python script receives, or None.

    The launcher is `_python_source`'s, then only value-free interpreter flags, then a
    literal `.py` path (`_PY_SCRIPT`). The words after that path are the script's argv,
    which the guard reads as data for every other program too. `-c`, `-m`, `-` and every
    other flag return None, since each makes a later word the program (dotfiles #1000)."""
    rest = _past_uv_run(argv)
    if not rest or not re.fullmatch(r"python[0-9.]*", rest[0]):
        return None
    i = 1
    while i < len(rest) and _PY_FLAG.fullmatch(rest[i]):
        i += 1
    if i >= len(rest) or not _PY_SCRIPT.fullmatch(rest[i]):
        return None
    return len(argv) - len(rest) + i + 1


def _masked_attributes(program: str) -> str | None:
    """`program` with each attribute access's dot turned to `_` (`v.key` reads `v_key`), or
    None when the program is not safe to mask. A dot is masked only when it sits between a
    name, `)` or `]` and the attribute's name with no space on either side. Strings and
    comments are left as written. A program holding `$` or a backtick may be rewritten by
    the shell before Python sees it, so it is never masked."""
    if "$" in program or "`" in program or _ODD_BREAKS & set(program):
        return None
    lines = io.StringIO(program).readlines()
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(program).readline))
    except tokenize.TokenError, SyntaxError:
        return None
    starts = [0]
    for line in lines:
        starts.append(starts[-1] + len(line))
    chars = list(program)
    for prev, dot, name in zip(tokens, tokens[1:], tokens[2:], strict=False):
        if (
            dot.type == tokenize.OP
            and dot.string == "."
            and name.type == tokenize.NAME
            and (prev.type == tokenize.NAME or prev.string in (")", "]"))
            and prev.end == dot.start
            and dot.end == name.start
        ):
            at = starts[dot.start[0] - 1] + dot.start[1]
            if chars[at] != ".":
                return None
            chars[at] = "_"
    return "".join(chars)


def _without_python_attributes(sc: Scan) -> Scan:
    """`sc` rebuilt with the attribute accesses of certain Python source masked
    (`_masked_attributes`). Segments are read in order: a `_BEFORE_PYTHON` command is
    passed over, a closed-shape Python segment (`_python_source`) is masked, and anything
    else stops the masking for the rest of the command. A command with a substitution is
    left as it is, and so is a program whose text the command holds other than once."""
    p = parse(sc.command)
    if not p.ok or p.substitutions:
        return sc
    command = sc.command
    for seg in p.segments:
        words = _words(seg.text)
        if not words:
            break
        source = _python_source(words, seg.heredocs)
        if source is None:
            if words[0] in _BEFORE_PYTHON:
                continue
            break
        masked = _masked_attributes(source)
        if masked is not None and command.count(source) == 1:
            command = command.replace(source, masked)
    return sc if command == sc.command else build_scan(command)


# An interpreter word ends where a command word does. A word followed by `/` or `.` is
# a path component or a file name: `lib/python3.11/site-packages/airflow/secrets/` names
# no interpreter. A trailing `\b` would not do: `python[0-9.]*` backtracks to `python3.`,
# which ends at a word boundary before the `11`.
_INTERPRETER_WORD = r"\b(python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript|osascript)(?![\w./])"
# The words of an environment variable name that mark it a credential. A name is split on
# `_` and on camelCase, then compared word by word, so `GITHUB_TOKEN` and `apiKey` match
# while `TOKENIZERS_PARALLELISM`, `HOME` and `TMPDIR` do not.
_SECRET_NAME_WORDS = frozenset(
    {
        "TOKEN",
        "TOKENS",
        "SECRET",
        "SECRETS",
        "PASSWORD",
        "PASSWORDS",
        "PASSWD",
        "PASSPHRASE",
        "CREDENTIAL",
        "CREDENTIALS",
        "APIKEY",
        "KEY",
        "KEYS",
        "PAT",
    }
)
# An interpreter's read of one variable, the name captured: Python `os.environ[…]`,
# `.environ.get(…)` and `getenv(…)`, Node `process.env.X` and `process.env[…]`, Ruby
# `ENV[…]` and `ENV.fetch(…)`, Perl `$ENV{…}`, Deno `Deno.env.get(…)`. Matched on the raw
# command, so the quotes around the name are optional, and so is the backslash a double-quoted
# `-c` argument puts before an inner quote (`os.environ[\"X\"]`).
_ENV_ACCESS = re.compile(
    r"(?:\benvironb?(?:\.get|\.pop|\.setdefault)?\s*[\[(]|\bgetenv\s*\(|\bprocess\.env\s*\[|"
    r"\bENV\s*\[|\bENV\.fetch\s*\(|\$ENV\{|\bDeno\.env\.get\s*\()\s*b?\\?[\"']?"
    r"([A-Za-z_][A-Za-z0-9_]*)|\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)"
)
_PRINTENV = re.compile(
    r"(?:^|[\s;&|(`])printenv((?:\s+-\S+)*(?:\s+[\"']?[A-Za-z_][A-Za-z0-9_]*[\"']?)+)"
)


def _secret_name(name: str) -> bool:
    words = re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+", name)
    return any(w.upper() in _SECRET_NAME_WORDS for w in words)


# A Python program that only names an accessor inside a string literal, such as an edit script
# writing `os.environ["PLANKA_PASSWORD"]` into source, reads nothing (the 2026-10-21 denial). A
# program that can run a string as code keeps every match: `exec("…os.environ['X']…")` reads.
_RUNS_STRING = re.compile(
    r"\b(?:exec|eval|compile|system|popen|subprocess|spawn\w*|execv\w*|execl\w*|run|call)\s*\("
)
_LITERAL_TOKENS = frozenset(
    t
    for t in (
        tokenize.STRING,
        getattr(tokenize, "FSTRING_MIDDLE", None),
        getattr(tokenize, "TSTRING_MIDDLE", None),
    )
    if t is not None
)


def _python_programs(command: str) -> list[str]:
    """The heredoc bodies and `-c` arguments of `command`: the texts that may be Python."""
    p = parse(command)
    if not p.ok:
        return []
    programs = [body for seg in p.segments for body in seg.heredocs]
    for seg in p.segments:
        try:
            words = shlex.split(seg.text)
        except ValueError:
            continue
        programs += [words[i + 1] for i, w in enumerate(words[:-1]) if w == "-c"]
    return programs


def _env_names_only_in_strings(command: str) -> Counter[str]:
    """How many times each variable name's accessor sits inside a Python string literal of a
    program in `command`, for programs that tokenize as Python and run no string as code."""
    found: Counter[str] = Counter()
    for program in _python_programs(command):
        if _RUNS_STRING.search(program):
            continue
        try:
            tokens = list(tokenize.generate_tokens(io.StringIO(program).readline))
        except tokenize.TokenError, SyntaxError:
            continue
        starts = [0]
        for line in program.splitlines(keepends=True):
            starts.append(starts[-1] + len(line))
        spans = [
            (starts[t.start[0] - 1] + t.start[1], starts[t.end[0] - 1] + t.end[1])
            for t in tokens
            if t.type in _LITERAL_TOKENS
        ]
        for m in _ENV_ACCESS.finditer(program):
            if any(a <= m.start() < b for a, b in spans):
                found[m.group(1) or m.group(2)] += 1
    return found


def secret_env(sc: Scan, target: str) -> Verdict | None:
    """A read of one environment variable whose name marks it a credential: `printenv NAME`,
    or an interpreter's accessor in a command that runs an interpreter. The `.env` branch of
    SECRET_PATHS stopped matching `os.environ` (#861), which had also been the only thing
    refusing `os.environ['AWS_SECRET_ACCESS_KEY']`, and `ENV_DUMP` refuses only a bare dump.
    The OS sandbox does not cover the environment, so this rule is the only layer there.
    The name decides: `os.environ['HOME']` and `printenv TMPDIR` pass. A stored heredoc is
    skipped as in the secret-read rules."""
    sc = _without_stored_heredocs(sc)
    names: list[str] = []
    for m in _PRINTENV.finditer(sc.command):
        names += [w.strip("\"'") for w in m.group(1).split() if not w.startswith("-")]
    if bdb_re(sc.scan, _INTERPRETER_WORD):
        accessed = Counter(a or b for a, b in _ENV_ACCESS.findall(sc.command))
        names += list((accessed - _env_names_only_in_strings(sc.command)).elements())
    secrets = list(dict.fromkeys(n for n in names if _secret_name(n)))[:5]
    if not secrets:
        return None
    return Verdict(
        "deny",
        "secret-env",
        "Blocked: this reads a credential from the environment into the session. Ask the "
        "user to share the specific value needed, or run a tracked script that reads it "
        f"without printing it.{_naming(secrets)}",
    )


# --- decrypting rather than reading (:951-1044) -----------------------------------------------

# :971-972. DECIDED (:958-963): these are their own arms, not SECRET_PATHS entries.
# DECIDED (2026-10-24, approved, the `.env.j2` ruling's analogue): a Jinja template whose
# name ends in `secret.yaml.j2` or `.sops.yaml.j2` is tracked source that renders at deploy, so
# the lookahead exempts a trailing `.j2`. The rendered `app-secret.yaml`, a `.j2.bak` copy and a
# `.j2/` directory are still refused. 12 of a week's write and in-place denials were writes of
# such a template (the 2026-10-17 to 2026-10-24 replay).
SOPS_BASENAMES = (
    r"((secrets?\.(ya?ml|json|env|ini)|[^[:space:]/]+\.sops\.(ya?ml|json|env|ini))"
    r"(?!\.j2(?![A-Za-z0-9_./-])))"
)
SOPS_PATHS = rf"(^|[[:space:]])([^[:space:]]*/)?{SOPS_BASENAMES}\b"
# :983. Command position with an env assignment or an ssh/hl host allowed before the binary.
BDB_CMD_AT = (
    r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*"
    r"((ssh|hl)[[:space:]]+[^[:space:]]+[[:space:]]+)*"
)


def sops_decrypt(sc: Scan, target: str) -> Verdict | None:
    """:985-992."""
    if bdb_re(
        f"{sc.scan}\n{sc.lines}",
        rf"{BDB_CMD_AT}sops\b[^;&|]*((^|[[:space:]])--decrypt([[:space:]]|=|$)|"
        r"(^|[[:space:]])-[A-Za-z]*d([[:space:]]|$)|(^|[[:space:]])(decrypt|exec-env|exec-file)"
        r"([[:space:]]|$))",
    ):
        return Verdict(
            "deny",
            "sops-decrypt",
            "Blocked: this decrypts a SOPS file into the session. Ask the user for the one "
            "value you need, or use `sops <file>` to edit without printing plaintext.",
        )
    return None


def git_sops_diff(sc: Scan, target: str) -> Verdict | None:
    """:994-1014. `--stat`, `--name-only`, `--name-status` emit no content and are exempt. An
    exclude pathspec (`:!secrets.yml`, `:^…`, `:(exclude)…`) keeps the file out of the diff,
    so it is dropped before the match, as `_EXCLUDE_WORD` drops it for the readers."""
    subject = re.sub(
        r"(^|\s):(!|\^|\([^)]*exclude[^)]*\))\S*", r"\1", f"{sc.scan}\n{sc.lines}", flags=re.M
    )
    if bdb_re(
        subject,
        rf"{BDB_CMD_AT}git\b[^;&|]*(\bdiff\b|\bshow\b|\blog\b[^;&|]*(-p|--patch)\b)[^;&|]*"
        rf"{SOPS_PATHS}",
    ) and not bdb_re(subject, r"(^|[[:space:]])--(stat|name-only|name-status)([[:space:]]|=|$)"):
        return Verdict(
            "deny",
            "git-sops-diff",
            "Blocked: the sops diff driver decrypts before diffing, so this prints plaintext "
            "credentials. Use `git diff --stat` or `--name-only` to see THAT it changed, and "
            "`sops <file>` to inspect it.",
        )
    return None


def systemctl_env(sc: Scan, target: str) -> Verdict | None:
    """:1016-1046."""
    if bdb_re(sc.scan, rf"{BDB_CMD_AT}systemctl\b[^;&|]*(^|[[:space:]])cat([[:space:]]|$)"):
        return Verdict(
            "deny",
            "systemctl-cat",
            "Blocked: `systemctl cat` prints the unit file, Environment= lines and all. Use "
            "`systemctl show -p <Property> <unit>` for a STRUCTURAL field (ActiveState, User, "
            "NRestarts); the Environment and Exec* properties are denied there too, because "
            "they render the unit's secrets and its argv.",
        )
    if bdb_re(sc.scan, rf"{BDB_CMD_AT}systemctl\b[^;&|]*(^|[[:space:]])show([[:space:]]|$)"):
        if not bdb_re(sc.scan, r"(^|[[:space:]])(-p|--property)([[:space:]]|=)"):
            return Verdict(
                "deny",
                "systemctl-show",
                "Blocked: an unnarrowed `systemctl show` prints the unit's resolved "
                "environment. Add `-p <Property>`.",
            )
        if bdb_re(sc.scan, r"\bsystemctl\b[^;&|]*(-p|--property)[[:space:]=][^;&|]*Environment"):
            return Verdict(
                "deny",
                "systemctl-show-environment",
                "Blocked: the Environment property holds the unit's secrets. Ask the user for "
                "the one value you need.",
            )
        # ExecStart/ExecStop/ExecReload/ExecCondition (and their Pre/Post/Ex suffixes) render
        # the command's full argv. `Exec` alone would also match ExecMainPID, ExecMainStatus
        # and ExecMainStartTimestamp, which carry no argv and stay allowed.
        if bdb_re(
            sc.scan,
            r"\bsystemctl\b[^;&|]*(-p|--property)[[:space:]=][^;&|]*"
            r"Exec(Start|Stop|Reload|Condition)",
        ):
            return Verdict(
                "deny",
                "systemctl-show-exec",
                "Blocked: an Exec* property renders the command's full argv, so a unit that "
                "passes a token or URL as an argument prints it. Ask the user for the one "
                "value you need, or read a structural property such as ActiveState, User or "
                "NRestarts.",
            )
    return None


def docker_inspect(sc: Scan, target: str) -> Verdict | None:
    """:1048-1061."""
    if not bdb_re(sc.scan, rf"{BDB_CMD_AT}docker\b[^;&|]*(^|[[:space:]])inspect([[:space:]]|$)"):
        return None
    if not bdb_re(sc.scan, r"(^|[[:space:]])inspect\b[^;&|]*(--format|-f)([[:space:]]|=)"):
        return Verdict(
            "deny",
            "docker-inspect-unformatted",
            "Blocked: an unformatted `docker inspect` prints Config.Env in plaintext. Add "
            "`--format`, e.g. `-f '{{.NetworkSettings.IPAddress}}'`.",
        )
    if bdb_re(
        sc.scan,
        r"(^|[[:space:]])inspect\b[^;&|]*(--format|-f)([[:space:]]|=)[^;&|]*"
        r"(\.Config|Env|json[[:space:]]+\.[[:space:]}])",
    ):
        return Verdict(
            "deny",
            "docker-inspect-env",
            "Blocked: this format reaches the container's environment. Name the specific "
            "field you need.",
        )
    return None


# --- writes and in-place edits (:1046-1084) --------------------------------------------------

# The files git reads config and hooks from (dotfiles #711). A write to one plants what
# `push-config-write` denies through `git config`: a `+` or main refspec, a mirror, a
# force-pushing alias, or a hooks path or hook that skips the pre-push signature gate. Covered:
# a repo's `.git/config` and `config.worktree`, the same under `.git/worktrees/<name>/` and
# `.git/modules/<name>/`, a bare `<name>.git/config`, any `.git/hooks*/` directory (this
# repo's gate runs from `.git/hooks-safe/`), `~/.gitconfig`, everything under
# `~/.config/git/` (the XDG config and `local.config`, which `~/.gitconfig` includes), a
# `$XDG_CONFIG_HOME/git/config`, and `/etc/gitconfig`. A push that swaps in another config
# file (GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, HOME, XDG_CONFIG_HOME) or an include is denied
# by `push-config`, and a persistent include by `push-config-write`. Out of reach as text: the
# config of a bare repo whose directory lacks the `.git` suffix, and the contents of an
# `include.path` target outside `~/.config/git/` set before this rule. Not listed, because
# neither can make a push force or skip a hook: `.gitmodules` (git refuses a `!command`
# update from it) and
# `.gitattributes`/`.git/info/` (an attribute only selects a driver that config defines).
_GIT_END = r"([^[:alnum:]_.-]|$)"
GIT_CONFIG_PATHS = (
    rf"(\.git/([^[:space:];&|]*/)?(config(\.worktree)?{_GIT_END}"
    rf"|hooks[^/[:space:];&|]*(/|{_GIT_END}))"
    rf"|\.gitconfig{_GIT_END}|/etc/gitconfig{_GIT_END}|\.config/git/|/git/config{_GIT_END})"
)
# :1064. SOPS basenames on the WRITE side only (:1057-1063).
WRITE_TARGETS = (
    rf"({SECRET_PATHS}|{SOPS_BASENAMES}|authorized_keys|\.bashrc|\.zshrc|\.bash_profile|"
    rf"\.zprofile|\.profile|\.claude/settings\.json|\.claude/hooks/|{GIT_CONFIG_PATHS})"
)
# :1081. Editors that unambiguously rewrite the file they name; cp/mv deliberately absent.
BDB_INPLACE = (
    r"((sed|perl)\b[^;&|]*(^|[[:space:]])(-[A-Za-z]*i([[:space:]]|\.)|--in-place)|truncate\b|"
    r"dd\b[^;&|]*(^|[[:space:]])of=)"
)
# A redirect, or any file argument of tee (tee writes every file it names, not just the first).
# `tee` is anchored at a word start, so that "guarantee the .git/config" in a commit message
# does not read as tee's arguments. The arguments stop at a redirect and at three words,
# because SCAN collapses a heredoc body onto the tee line: unbounded, the census over this
# host's transcripts read six `tee f.py >/dev/null <<'EOF'` scripts as writing a path their
# body mentions.
_REDIRECT_OR_TEE = (
    r"(>[>|]?|(^|[^[:alnum:]_-])tee([[:space:]]+[^[:space:];&|<>]+){0,3}[[:space:]]+)"
    r"[[:space:]]*[^[:space:];&|]*"
)
# cp/mv/install/ln/rsync ONTO a git config or hook file (#711): the destination is the last
# word, before any trailing redirect, or the value of -t/--target-directory. A target earlier
# in the line is a source, i.e. a read, which is why BDB_INPLACE leaves these out. Scoped to
# GIT_CONFIG_PATHS: over the full WRITE_TARGETS list the corpus replay gained two false
# denies, a `git mv` and a `cp` into a project's own `.claude/hooks/tests/`. `git mv` is not a
# copy here, since git refuses a path inside `.git/`.
_COPY_AT = (
    r"(^|[;&|(`/]|[;&|(`][[:space:]]*|(^|[^[:alnum:]_-])(sudo|doas|command|nohup)[[:space:]]+)"
)
_COPY_CMD = rf"{_COPY_AT}(cp|mv|install|ln|rsync)[[:space:]]"
_COPY_ONTO = (
    rf"{_COPY_CMD}[^;&|]*[[:space:]][^[:space:];&|]*{GIT_CONFIG_PATHS}[^[:space:];&|]*"
    r"([[:space:]]+[0-9]*[<>][^[:space:];&|]*)*[[:space:]]*$"
)
# Removing, moving away or de-executing a hook or config file skips the gate as surely as
# overwriting it: git, and this repo's hooks-safe shim, run nothing when the hook is missing
# or not executable, and moving .git/config away drops core.hooksPath (#711).
_GIT_FILE_UNSET = rf"{_COPY_AT}(rm|unlink|chmod|chattr|mv)[[:space:]][^;&|]*{GIT_CONFIG_PATHS}"
_COPY_INTO_DIR = (
    rf"{_COPY_CMD}[^;&|]*[[:space:]](-t[[:space:]]*|--target-directory[=[:space:]]+)"
    rf"[^[:space:];&|]*{GIT_CONFIG_PATHS}"
)


def write_targets(sc: Scan, target: str) -> Verdict | None:
    """:1082-1084, plus every file argument of tee and a copy onto a target (#711)."""
    if bdb_re(sc.scan, rf"{_REDIRECT_OR_TEE}{WRITE_TARGETS}") or any(
        bdb_re(sc.segset, p) for p in (_COPY_ONTO, _COPY_INTO_DIR)
    ):
        return Verdict(
            "deny",
            "write-target",
            "Blocked: writing to a secrets, shell-startup, or git config/hook file. Ask the "
            "user to do this manually; an ordinary git setting goes through "
            "`git config <key> <value>`. A test fixture with a secret-like name may be "
            "written under `$CLAUDE_JOB_DIR/tmp/` or `$TMPDIR/` instead.",
        )
    if bdb_re(sc.segset, _GIT_FILE_UNSET):
        return Verdict(
            "deny",
            "git-file-unset",
            "Blocked: removing, moving or changing the mode of a git config or hook file can "
            "make a later push skip the pre-push gate or lose `core.hooksPath`. Ask the user "
            "to do this manually.",
        )
    return None


_REDIRECT_WORD = re.compile(r"[0-9]*[<>|&]+")


def _edit_operands(args: list[str], value_opts: str, script_opts: str, rest_opts: str) -> list[str]:
    """The file operands of a sed or perl argv tail `args`: the positional words, less the
    first when no option carried the script. In a short-option cluster, a letter in
    `value_opts` takes the rest of the word or the next one as its value, and one in
    `script_opts` also marks the script as given. A letter in `rest_opts` takes the rest of
    the word (`-i.bak`, `-0777`). A redirect and its target are not operands."""
    positional: list[str] = []
    script = False
    i = 0
    while i < len(args):
        w = args[i]
        if w == "--":
            positional += args[i + 1 :]
            break
        if _REDIRECT_WORD.fullmatch(w):
            i += 2
            continue
        if w.startswith("--"):
            name = w.split("=", 1)[0]
            script |= name in ("--expression", "--file")
            i += 2 if name == w and name in ("--expression", "--file", "--line-length") else 1
            continue
        if w.startswith("-") and len(w) > 1:
            for j, c in enumerate(w[1:], 1):
                if c in rest_opts:
                    break
                if c in value_opts:
                    script |= c in script_opts
                    i += j == len(w) - 1
                    break
            i += 1
            continue
        positional.append(w)
        i += 1
    return positional if script else positional[1:]


def _inplace_edits_only_safe_files(command: str) -> bool:
    """Whether every in-place edit in `command` is a plain sed or perl whose file operands
    name no WRITE_TARGETS path. The script word is text the editor runs on a file, so a
    `secrets.yml` inside `s/…/…/` names no file. Anything else that matched the rule keeps
    its refusal: truncate, dd, a wrapper such as find, xargs or ssh, a substitution, a heredoc
    body, or text the parser refuses."""
    p = parse(command)
    if not p.ok or p.substitutions:
        return False
    pattern = rf"{BDB_CMD_AT}{BDB_INPLACE}[^;&|]*{WRITE_TARGETS}"
    cleared = False
    for seg in p.segments:
        if any(bdb_re(normalize(b), pattern) for b in seg.heredocs):
            return False
        if not bdb_re(normalize(seg.text), pattern):
            continue
        words = _words(seg.text)
        argv = _argv(words) if words else []
        name = posixpath.basename(argv[0]) if argv else ""
        if name == "sed":
            files = _edit_operands(argv[1:], "efl", "ef", "i")
        elif name == "perl":
            files = _edit_operands(argv[1:], "eE", "eE", "iIMmx0ld")
        else:
            return False
        if any(bdb_re(f, WRITE_TARGETS) for f in files):
            return False
        cleared = True
    return cleared


# The write targets that stay refused even inside a session's scratch directory: a file a
# later shell, git or Claude Code reads. Only a secret-NAMED fixture is let through there.
_PLANT_TARGETS = re.compile(
    _ere(
        r"(authorized_keys|\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile|"
        rf"\.claude/settings\.json|\.claude/hooks/|{GIT_CONFIG_PATHS})"
    )
)


def _in_scratch(path: str, env: Mapping[str, str]) -> bool:
    """Whether the absolute `path` sits in a session scratch directory: some job's
    `~/.claude/jobs/<id>/tmp/`, or `$TMPDIR` unless that is bare `/tmp`, which other jobs and
    a deploy's dry run share. The hook process sees TMPDIR but not CLAUDE_JOB_DIR, which the
    harness sets only in the Bash tool's shell, so a job directory is matched by shape."""
    path = posixpath.normpath(path)
    home = env.get("HOME", "").rstrip("/")
    if home and re.match(rf"{re.escape(home)}/\.claude/jobs/[^/]+/tmp/", path):
        return True
    tmp = posixpath.normpath(env.get("TMPDIR", "") or "/")
    return tmp not in ("/", "/tmp") and path.startswith(tmp + "/")


def _writes_only_scratch_fixtures(command: str, env: Mapping[str, str], target: str) -> bool:
    """Whether every write-target match in `command` is a secret-named fixture written into a
    session scratch directory (`_in_scratch`), the operator's 2026-10-24 ruling. Each
    redirect target and tee file whose path sits there, holds no `..` and names no plant
    target is blanked from the command, and the command is matched again: anything left
    over keeps the refusal. `$CLAUDE_JOB_DIR` stands for `~/.claude/jobs/<id>` and `$TMPDIR`
    for its value, unless the command assigns either one itself. A command the parser
    refuses is not exempt."""
    p = parse(command)
    if not p.ok or re.search(r"\b(CLAUDE_JOB_DIR|TMPDIR)=", command):
        return False
    stand_in = {
        "CLAUDE_JOB_DIR": f"{env.get('HOME', '').rstrip('/')}/.claude/jobs/job",
        "TMPDIR": env.get("TMPDIR", ""),
    }
    blanked = command
    for seg in p.segments:
        words = _words(seg.text) or []
        argv = _argv(words)
        tee = bool(argv) and posixpath.basename(argv[0]) == "tee"
        for i, w in enumerate(words):
            after_redirect = i > 0 and _WRITE_REDIRECT.fullmatch(words[i - 1]) is not None
            if not (after_redirect or (tee and i > 0 and not w.startswith("-"))):
                continue
            path = w
            for name, value in stand_in.items():
                path = path.replace(f"${{{name}}}", value).replace(f"${name}", value)
            if (
                "$" not in path
                and ".." not in path.split("/")
                and _in_scratch(path, env)
                and not _PLANT_TARGETS.search(path)
            ):
                blanked = blanked.replace(w, "scratch-fixture")
    return blanked != command and write_targets(build_scan(blanked), target) is None


def inplace_edit(sc: Scan, target: str) -> Verdict | None:
    """:1099-1101. A match is cleared when only a sed or perl script names the target
    (`_inplace_edits_only_safe_files`)."""
    if bdb_re(
        sc.scan, rf"{BDB_CMD_AT}{BDB_INPLACE}[^;&|]*{WRITE_TARGETS}"
    ) and not _inplace_edits_only_safe_files(sc.command):
        return Verdict(
            "deny",
            "inplace-edit",
            "Blocked: editing a secrets, shell-startup, or git config/hook file in place. A "
            "SOPS file must go through `sops <file>`, an ordinary git setting through "
            "`git config <key> <value>`; ask the user before changing the others.",
        )
    return None


# --- terraform / tofu / terragrunt (:1086-1118) -----------------------------------------------

TF_HUMAN = "Use plan to preview; a human applies infra changes."
_TF_VERB = (
    rf"{TF_AT}{TF_BIN}\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+"
    r"(apply|destroy|import|taint|untaint|force-unlock)\b"
)


def terraform(sc: Scan, target: str) -> Verdict | None:
    """:1112-1135. Every arm reads the scan set and folds case."""
    subject = sc.scanset
    if bdb_rei(subject, _TF_VERB):
        return Verdict(
            "deny",
            "terraform-apply",
            "Blocked: state-mutating/destructive terraform command "
            f"(apply/destroy/import/taint/force-unlock). {TF_HUMAN}",
        )
    if bdb_rei(
        subject,
        rf"{TF_AT}terragrunt\b([[:space:]]+-[^[:space:]]+)*[[:space:]]+(run-all|run)"
        r"([[:space:]]+(--all|-[^[:space:]]+))*[[:space:]]+(apply|destroy|import)\b",
    ):
        return Verdict(
            "deny",
            "terragrunt-run",
            f"Blocked: destructive terragrunt run-all/run command. {TF_HUMAN}",
        )
    if bdb_rei(subject, rf"{TF_AT}{TF_BIN}\b.*\bstate[[:space:]]+(rm|mv|push|replace-provider)\b"):
        return Verdict(
            "deny",
            "terraform-state",
            "Blocked: terraform state mutation (state rm/mv/push/replace-provider). state "
            "list/show are fine; mutations must be done by a human.",
        )
    if bdb_rei(subject, rf"{TF_AT}{TF_BIN}\b.*\bworkspace[[:space:]]+delete\b"):
        return Verdict(
            "deny",
            "terraform-workspace-delete",
            "Blocked: terraform/tofu workspace delete drops its state.",
        )
    if bdb_rei(subject, rf"{TF_AT}{TF_BIN}\b.*[[:space:]]--?auto-approve\b"):
        return Verdict(
            "deny",
            "terraform-auto-approve",
            "Blocked: terraform -auto-approve. Non-interactive apply/destroy is not permitted.",
        )
    return None


# --- the --force / -f flag on any branch (dotfiles #701) --------------------------------------

# `git push -h` lists v q d n f u o 4 6 as short options; only -o takes a value.
_FORCE_ANY = rf"{GIT_PUSH_AT}.*{_FORCE_WORD}"
_FORCE_CLUSTER = rf"{GIT_PUSH_AT}.*\s-[vqdnu46]*f"
_PLUS_REFSPEC = rf"{GIT_PUSH_AT}.*\s\+[^\s]"
_MIRROR = rf"{GIT_PUSH_AT}.*\s--mirror([ ]|=|$)"


def force_push_flag(sc: Scan, target: str) -> Verdict | None:
    """A `--force` or `-f` push to any branch. main/master was denied above with its own
    message; this covers the feature branch.

    DECIDED (dotfiles #701): deny, not the bash's upgrade (:1147-1159), which rewrote the flag
    to `--force-with-lease` through `updatedInput` and ALLOWED the result. The settings deny
    `-f`/`--force` in any position on any branch, so the upgrade stated the opposite intent,
    and it rewrote a command the model had not written. A deny with the lease spelling in its
    reason costs the model one retry. Unlike `force_push`, a `--force-with-lease` elsewhere
    in the command exempts nothing: `git push --force-with-lease origin feat -f` still
    forces. Read per segment, so a `-f` in a later stage (`ls -f`) is not a push flag.

    Two more spellings force without a `-f` word (dotfiles #706). `_FORCE_CLUSTER` is an `f`
    in a short-option cluster (`-uf`, `-fu`): only git push's no-value letters may precede
    it, because `-o` takes the rest of the cluster as its value (`-ofix` is `-o fix`), and
    `--` never starts a match, so `--force-with-lease` and `--follow-tags` stay clear.
    `_PLUS_REFSPEC` is a word that starts with `+` (`+feat`, `+HEAD:feat`); a `+` inside a
    value (`-o ci.variable=a+b`) is not at a word start. `_FORCE_FLAG` itself is left as
    the bash has it, because `force_push` shares it.

    #709 closed the rest of the class. Every pattern anchors on GIT_PUSH_AT, so git's global
    options, a wrapper, or an inline alias before the push hide nothing. send-pack, the
    plumbing under push, reads the same. `--mirror` force-updates every remote ref, so it is a
    force too."""
    if any(bdb_re(sc.segset, p) for p in (_FORCE_ANY, _FORCE_CLUSTER, _PLUS_REFSPEC, _MIRROR)):
        return Verdict(
            "deny",
            "force-push-flag",
            "Blocked: `--force`/`-f`/`+<refspec>`/`--mirror` push. Use "
            "`git push --force-with-lease <remote> <branch>`, which refuses to overwrite "
            "commits you have not fetched. main/master stays denied either way.",
        )
    return None


# --- config and hooks that change what a push does (dotfiles #709) --------------------------

_GIT_FALSE = frozenset({"false", "no", "off", "0", ""})
_MAIN_REFS = frozenset({"main", "master", "refs/heads/main", "refs/heads/master"})

# The same decisions for text the parser cannot read, paired with GIT_PUSH_AT in one member.
_PUSH_CONFIG_TEXT = (
    r"remote\.[^\s=]+\.push=\s*\+"
    r"|remote\.[^\s=]+\.push=[^\s]*:(refs/heads/)?(main|master)(\s|$)"
    r"|\s-c\s+remote\.[^\s=]+\.mirror(\s|=\s*(true|yes|on|1)(\s|$))"
    r"|--config-env[\s=]+remote\.[^\s=]+\.(push|mirror)="
    r"|GIT_CONFIG_VALUE_[0-9]+=\s*\+"
    r"|GIT_CONFIG_KEY_[0-9]+=remote\.[^\s=]+\.mirror"
    r"|GIT_CONFIG_PARAMETERS=.*remote\.[^\s=]+\.(push|mirror)"
    r"|\s-c\s+include(if\.[^\s=]+)?\.path="
    r"|--config-env[\s=]+include(if\.[^\s=]+)?\.path="
    r"|GIT_CONFIG_KEY_[0-9]+=include(if\.[^\s=]+)?\.path"
    r"|GIT_CONFIG_PARAMETERS=.*include(if\.[^\s=]+)?\.path"
)
# A config FILE swapped in for the push (#711): git reads its global config from
# GIT_CONFIG_GLOBAL, $HOME/.gitconfig or $XDG_CONFIG_HOME/git/config, and its system config
# from GIT_CONFIG_SYSTEM, so any of these set in the push's command points git at a file no
# write rule has seen. Read from the whole command, since `export X=…; git push` sets it too.
_CONFIG_FILE_ENV = r"(^|[\s;&|(`])(GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|XDG_CONFIG_HOME|HOME)="
_HIDDEN_ALIAS_TEXT = r"git\s[^;&|]*--config-env[\s=]+alias\."
_NO_VERIFY_TEXT = r"(\s--no-veri(f|fy)?([ ]|=|$)|core\.hookspath)"


def _config_forces(key: str, value: str | None) -> bool:
    """Does one inline config entry make a plain push force, mirror, or land on main? An
    include counts (#711): it pulls in a file whose contents no rule has read."""
    if key == "include.path" or (key.startswith("includeif.") and key.endswith(".path")):
        return True
    if not key.startswith("remote."):
        return False
    if key.endswith(".mirror"):
        return value is None or value.lower() not in _GIT_FALSE
    if not key.endswith(".push"):
        return False
    if value is None:  # --config-env: the refspec is in a variable the command hides
        return True
    refspec = value.strip()
    return refspec.startswith("+") or refspec.rpartition(":")[2] in _MAIN_REFS


def push_config(sc: Scan, target: str) -> Verdict | None:
    """A push whose inline config (`-c`, `--config-env`, GIT_CONFIG_KEY_n/VALUE_n,
    GIT_CONFIG_PARAMETERS) supplies a `+` refspec, a refspec onto main/master, or
    `remote.<name>.mirror`: a force push, or a push to main, that no flag in the command
    shows. An alias whose value `--config-env` hides counts too, since nothing shows what it
    runs. `push.default` stays no decision: `matching` pushes what `git push --all` does."""
    hit = any(
        (inv.sub in PUSH_SUBCOMMANDS and any(_config_forces(k, v) for k, v in inv.config))
        or (not inv.sub and not inv.shell)
        for inv in sc.gits
    )
    hit = hit or bdb_rei(sc.segset, _HIDDEN_ALIAS_TEXT)
    hit = hit or any(
        bdb_re(line, GIT_PUSH_AT) and bdb_rei(line, _PUSH_CONFIG_TEXT)
        for line in sc.segset.split("\n")
    )
    hit = hit or (bdb_re(sc.segset, GIT_PUSH_AT) and bdb_re(sc.scan, _CONFIG_FILE_ENV))
    if hit:
        return Verdict(
            "deny",
            "push-config",
            "Blocked: this push takes a remote refspec, mirror setting, alias or include "
            "from inline config (`-c`, `--config-env`, `GIT_CONFIG_*`), or a config file "
            "swapped in through GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, HOME or "
            "XDG_CONFIG_HOME, that can force-push, push to main/master, or hide what runs. "
            "Push with explicit arguments: "
            "`git push --force-with-lease <remote> <branch>`.",
        )
    return None


def _skips_hooks(inv: Invocation) -> bool:
    if inv.sub not in PUSH_SUBCOMMANDS:
        return False
    if any(key == "core.hookspath" for key, _ in inv.config):
        return True
    for arg in inv.args:
        if arg == "--":
            break
        # git accepts an unambiguous prefix of a long option; `--no-ver` could also be
        # --no-verbose.
        if len(arg) >= len("--no-veri") and "--no-verify".startswith(arg):
            return True
    return False


def push_no_verify(sc: Scan, target: str) -> Verdict | None:
    """A push that skips the pre-push hook, the repo's signature gate: `--no-verify` behind
    a global option, where the settings glob `git push *--no-verify*` cannot see it, or
    `core.hooksPath` set inline, which is the same skip by another name."""
    if any(_skips_hooks(inv) for inv in sc.gits) or any(
        bdb_re(line, GIT_PUSH_AT) and bdb_rei(line, _NO_VERIFY_TEXT)
        for line in sc.segset.split("\n")
    ):
        return Verdict(
            "deny",
            "push-no-verify",
            "Blocked: `--no-verify` or an inline `core.hooksPath` skips the pre-push hook, "
            "which is the signature gate. Push without it and fix what the hook reports.",
        )
    return None


_PUSH_RULES = frozenset(
    {
        "force-push-main",
        "force-push-refspec",
        "push-main",
        "force-push-flag",
        "push-config",
        "push-no-verify",
    }
)

# The same writes for text the parser cannot read.
_CONFIG_WRITE_AT = rf"git{GLOBALS_RE}\s+config\b[^;&|]*\s"
_CONFIG_WRITE_TEXT = (
    rf"{_CONFIG_WRITE_AT}(remote\.[^\s=]+\.push\s+\+"
    r"|remote\.[^\s=]+\.push\s+[^\s]*:(refs/heads/)?(main|master)(\s|$)"
    r"|remote\.[^\s=]+\.mirror\s+(true|yes|on|1)(\s|$)"
    r"|core\.hookspath\s"
    r"|include(if\.[^\s]+)?\.path\s"
    r"|alias\.[^\s]+\s+!?[^;&|]*\b(push|send-pack|http-push)\b[^;&|]*"
    r"(\s-[vqdnu46]*f|--force(\s|$)|--mirror|\s\+|--no-veri))"
    rf"|git{GLOBALS_RE}\s+remote\s+add\b[^;&|]*\s--mirror(=push)?(\s|$)"
)


def _alias_pushes_badly(value: str) -> bool:
    """Would running this alias value be denied as a push?"""
    text = value[1:] if value.startswith("!") else f"git {value}"
    return deny(text).rule in _PUSH_RULES


def _write_forces(key: str, value: str) -> bool:
    if _config_forces(key, value) or key == "core.hookspath":
        return True
    return key.startswith("alias.") and _alias_pushes_badly(value)


def config_write(sc: Scan, target: str) -> Verdict | None:
    """A `git config` write or `git remote add --mirror` that makes a LATER plain push force,
    mirror, land on main/master, or skip the pre-push hook. `Bash(git push:*)` approves that
    later push with no prompt, and it reads clean to every rule above, so the write is where
    the decision has to be made. An alias counts when running its value would be denied as a
    push."""
    hit = any(
        remote_add_mirrors_push(inv) or any(_write_forces(k, v) for k, v in config_writes(inv))
        for inv in sc.gits
    )
    if hit or bdb_rei(sc.segset, _CONFIG_WRITE_TEXT):
        return Verdict(
            "deny",
            "push-config-write",
            "Blocked: this config write makes a later plain `git push` force, mirror, push to "
            "main/master or skip the pre-push hook (a `+` or main refspec, "
            "`remote.<name>.mirror`, `remote add --mirror`, `core.hooksPath`, an include, "
            "or an alias that force-pushes). Pass those choices on the push itself, where "
            "they are seen.",
        )
    return None


_MACHINE_SCOPES = frozenset({"--global", "--system"})


def machine_config_write(sc: Scan, target: str) -> Verdict | None:
    """A `git config --global` or `--system` invocation that is not a read (dotfiles #965).

    This replaces the settings deny `Bash(git config --global:*)`, which Claude Code applies
    before any hook runs and so also refused `git config --global --get …`. Reads go on to
    the judge, which approves them through `gitread.config_read`, the same test used here.
    """
    if any(
        inv.sub == "config" and _MACHINE_SCOPES & set(inv.args) and not config_read(inv.args)
        for inv in sc.gits
    ):
        return Verdict(
            "deny",
            "machine-config-write",
            "Blocked: this changes git config for every repository on the machine "
            "(`--global` or `--system`). Reading it with `--get`, `--get-all` or `--list` "
            "is allowed; ask the user to make the change.",
        )
    return None


# --- sudo at any command position (dotfiles #863) -----------------------------------------------

# On daniel-box the settings deny `Bash(sudo:*)` is lifted so the auto-mode classifier can
# reach the allow entry for the homelab-takeover-check wrapper (server#5508). This rule is the
# boundary there, and it runs on every host: it refuses every sudo except that one command
# line. The hook's deny side fails closed, so an exception in this code reaches the user as
# an ask, never as an allow.
SUDO_WRAPPER = "/usr/local/sbin/homelab-takeover-check"
_SUDO_ARG = re.compile(r"^[A-Za-z0-9_./,=:@+-]+$")
_ESCALATORS = frozenset({"sudo", "sudoedit", "sudo-rs", "doas", "pkexec", "su", "run0"})
_SHELLS = frozenset(
    {"sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish", "csh", "tcsh", "eval", "busybox"}
)
# Commands that exec the rest of their argv, or take a command as an argument.
_EXECUTORS = frozenset(
    {
        "command", "builtin", "exec", "env", "nohup", "setsid", "time", "nice", "ionice",
        "timeout", "stdbuf", "xargs", "watch", "flock", "chroot", "setpriv", "taskset", "chrt",
        "unshare", "nsenter", "runuser", "parallel", "find", "strace", "ltrace", "unbuffer",
        "script", "entr", "sg", "systemd-run", "firejail", "bwrap", "fakeroot", "sshpass",
    }
)  # fmt: skip


def _takes(one: str = "", two: str = "") -> dict[str, int]:
    return dict.fromkeys(one.split(), 1) | dict.fromkeys(two.split(), 2)


# Where each executor's command word sits: the options that take a separate value, and how
# many plain arguments come before the command (`timeout 5`, `flock FILE`). A glued `-n5` or
# `--signal=KILL` is one word; a short-option cluster is read as getopt reads it. find is
# absent: its commands follow `-exec` and kin. script is absent too, since it takes its
# command only as the `-c` payload.
_EXECUTOR_ARGS: dict[str, tuple[dict[str, int], int]] = {
    "command": (_takes(), 0),
    "builtin": (_takes(), 0),
    "exec": (_takes("-a"), 0),
    "env": (_takes("-u -C -S -P --unset --chdir --split-string"), 0),
    "nohup": (_takes(), 0),
    "setsid": (_takes(), 0),
    "time": (_takes("-f -o --format --output"), 0),
    "nice": (_takes("-n --adjustment"), 0),
    "ionice": (_takes("-c -n --class --classdata"), 0),
    "timeout": (_takes("-s -k --signal --kill-after"), 1),
    "stdbuf": (_takes("-i -o -e --input --output --error"), 0),
    "xargs": (_takes(
        "-I -J -R -n -L -P -s -d -E -a --max-args --max-lines --max-procs --max-chars "
        "--delimiter --eof --arg-file --process-slot-var"
    ), 0),
    "watch": (_takes("-n --interval"), 0),
    "flock": (_takes("-w -E --timeout --conflict-exit-code"), 1),
    "chroot": (_takes("--userspec --groups"), 1),
    "setpriv": (_takes(
        "--reuid --regid --ruid --euid --rgid --egid --groups --inh-caps --ambient-caps "
        "--bounding-set --securebits --pdeathsig --selinux-label --apparmor-profile "
        "--landlock-access --landlock-rule --seccomp-filter"
    ), 0),
    "taskset": (_takes(), 1),
    "chrt": (_takes("-T -P -D --sched-runtime --sched-period --sched-deadline"), 1),
    "unshare": (_takes(
        "-S -G -R -w --setuid --setgid --root --wd --map-user --map-group --map-users "
        "--map-groups --propagation --setgroups"
    ), 0),
    "nsenter": (_takes("-t -S -G --target --setuid --setgid"), 0),
    "runuser": (_takes("-u -g -G -s -w --user --group --supp-group --shell"), 0),
    "parallel": (_takes(
        "-j -S -a -d -I -n -N -L --jobs --sshlogin --arg-file --colsep --delimiter "
        "--replace --joblog --results --tmpdir --max-args"
    ), 0),
    "strace": (_takes("-o -e -p -s -u -E -a -b -I -O -P -S -X"), 0),
    "ltrace": (_takes("-o -e -p -s -u -a -A -D -F -l -n -x"), 0),
    "unbuffer": (_takes(), 0),
    "entr": (_takes(), 0),
    "sg": (_takes(), 1),
    "systemd-run": (_takes(
        "-u -p -E -M -H --unit --property --setenv --machine --host --description --slice "
        "--uid --gid --working-directory --nice --service-type --path-property "
        "--socket-property --timer-property --on-active --on-boot --on-startup "
        "--on-unit-active --on-unit-inactive --on-calendar"
    ), 0),
    "firejail": (_takes(), 0),
    "bwrap": (_takes(
        "--chdir --unsetenv --lock-file --sync-fd --uid --gid --hostname --info-fd "
        "--json-status-fd --userns-block-fd --seccomp --add-seccomp-fd --exec-label "
        "--file-label --remount-ro --proc --dev --tmpfs --mqueue --dir --block-fd --perms "
        "--size --argv0 --userns --userns2 --pidns --overlay-src",
        two="--setenv --bind --bind-try --dev-bind --dev-bind-try --ro-bind --ro-bind-try "
        "--symlink --file --bind-data --ro-bind-data --chmod",
    ), 0),
    "fakeroot": (_takes("-l -s -i --lib --faked"), 0),
    "sshpass": (_takes("-p -f -d -P"), 0),
}  # fmt: skip
_UV_TAKES = _takes(
    "--extra --no-extra --group --no-group --only-group --no-editable-package --env-file -w "
    "--with --with-editable --with-requirements --package --python-platform --index "
    "--default-index -i --index-url --extra-index-url -f --find-links --index-strategy "
    "--keyring-provider -P --upgrade-package --upgrade-group --resolution --prerelease "
    "--prerelease-package --fork-strategy --exclude-newer --exclude-newer-package "
    "--no-sources-package --reinstall-package --link-mode -C --config-setting "
    "--config-settings-package --no-build-isolation-package --no-build-package "
    "--no-binary-package --cache-dir --refresh-package -p --python --color "
    "--allow-insecure-host --directory --project --config-file --from -c --constraints -b "
    "--build-constraints --overrides --torch-backend"
)  # fmt: skip
_NPM_TAKES = _takes(
    "-p --package -w --workspace --prefix --userconfig --registry --cache --loglevel -c --call"
)
# The npm runner options whose value is a shell command line that npm runs in place of a
# command word: `npx -c 'eslint .'`, `npm exec --call='tsc -b'`.
_NPM_PAYLOAD_OPTIONS = ("-c", "--call")
_PNPM_TAKES = _takes(
    "-C --dir -F --filter --workspace-concurrency --reporter --resume-from --package --allow-build"
)
_BUN_TAKES = _takes("-p --package")
# Runners that exec a program named by a later word, keyed by the words that select that mode,
# with the options that take a separate value. The options before a subcommand are skipped
# with the same table, so `uv -q run` and `pnpm -C dir exec` match too. The uv and npm tables
# come from their `--help`; pnpm, yarn and bun are not installed here, so theirs come from
# their docs. The value of `npx -c` is a command line, which `_runner_payloads` parses as shell.
_RUNNER_ARGS: dict[tuple[str, ...], dict[str, int]] = {
    ("uv", "run"): _UV_TAKES,
    ("uv", "tool", "run"): _UV_TAKES,
    ("uvx",): _UV_TAKES,
    ("npx",): _NPM_TAKES,
    ("npm", "exec"): _NPM_TAKES,
    ("pnpm", "exec"): _PNPM_TAKES,
    ("pnpm", "dlx"): _PNPM_TAKES,
    ("pnpx",): _PNPM_TAKES,
    ("yarn", "exec"): _BUN_TAKES,
    ("yarn", "dlx"): _BUN_TAKES,
    ("bunx",): _BUN_TAKES,
    ("bun", "x"): _BUN_TAKES,
}
_FIND_EXEC = frozenset({"-exec", "-execdir", "-ok", "-okdir"})
# Interpreters whose argument is code: `os.system('sudo ...')` has no command position to find.
_INTERPRETERS = frozenset(
    {
        "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "lua", "php",
        "awk", "gawk", "mawk", "expect", "tclsh", "Rscript", "julia",
    }
)  # fmt: skip
_KEYWORDS = frozenset(
    {"coproc", "if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"}
)
# `X+=1 sudo id` and `a[0]=1 sudo id` both run sudo: bash takes an append and a subscript
# as a prefix assignment too, the second with only a warning (2026-10-24).
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=")
_PLAIN_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_BRACE_LIST = re.compile(r"\{[^}]*(,|\.\.)[^}]*\}")
_LOOSE_SPLIT = re.compile(r"""[\s;&|()<>`'"=,{}\\$]+""")
SUDO_MSG = (
    "Blocked: sudo is refused except `sudo -n /usr/local/sbin/homelab-takeover-check` followed "
    "by plain argument words (letters, digits and _ . / , = : @ + -). Any other sudo option, "
    "a wrapper or shell in front of sudo, doas, pkexec, su, or an argument with a shell "
    "metacharacter is not that command."
)
SUDO_VARIABLE_MSG = (
    'Blocked: a command word is a variable or a substitution (`"$H"`, `$(…)`), which the '
    "sudo boundary cannot resolve and so refuses, since it could spell sudo. Spell the path "
    "as the command word instead."
)
# What a command shows the sudo boundary, in rising order: the highest rank found anywhere in
# the command decides the message, so a real sudo beside a variable command word is still
# reported as sudo.
_SUDO_CLEAN, _SUDO_VARIABLE, _SUDO_ESCALATES = 0, 1, 2
# What a substitution reads as when a segment is split into words: one word, and an expansion.
_SUB_PLACEHOLDER = "$CLAUDE_GUARD_SUB"


def _loose_hit(s: str) -> bool:
    """Whether any word of `s`, split on shell punctuation, names a privilege escalator."""
    return any(posixpath.basename(p) in _ESCALATORS for p in _LOOSE_SPLIT.split(s) if p)


def _command_lines(words: list[str]) -> tuple[list[list[str]], bool, list[str]]:
    """(the simple commands, whether any redirect appeared, here-string operands). A redirect
    and its operand are dropped, so `2>/dev/null sudo` leaves `sudo` in command position."""
    cmds: list[list[str]] = []
    cur: list[str] = []
    redirected = False
    here: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        i += 1
        if w and set(w) <= set(";&|()<>"):
            if set(w) & set("();") or not set(w) & set("<>"):
                cmds.append(cur)
                cur = []
                continue
            redirected = True
            if cur and cur[-1].isdigit():
                cur.pop()
            if i < len(words):
                if w == "<<<":
                    here.append(words[i])
                i += 1
            continue
        cur.append(w)
    cmds.append(cur)
    return cmds, redirected, here


def _is_interpreter(name: str) -> bool:
    return name in _INTERPRETERS or re.fullmatch(r"python[0-9.]*", name) is not None


# The runners that start a program on this host. docker, kubectl, ssh and hl start it in a
# container or on another machine, where a sudo or su is not this boundary's: the `remote`
# rule covers ssh and hl, and access to docker is root on the host already.
_HOST_RUNNERS = _RUNNERS - {"docker", "kubectl", "ssh", "hl"}


def _runs_interpreter(argv: list[str]) -> bool:
    """Whether the command `argv` runs an interpreter: `python3.11`, or one behind a runner
    or executor (`uv run python -`, `env python3 -c …`, `timeout 5 node`)."""
    names = [posixpath.basename(w) for w in argv]
    if _is_interpreter(names[0]):
        return True
    wrapper = names[0] in _HOST_RUNNERS or names[0] in _EXECUTORS
    return wrapper and any(map(_is_interpreter, names[1:]))


def _names_by_expansion(word: str) -> bool:
    """Whether only a variable or substitution names the program `word` runs. A word with a
    space in it is a quoted payload, which the caller parses as shell instead."""
    name = posixpath.basename(word)
    return any(c in name for c in "$`") and " " not in name


def _past_options(
    argv: list[str],
    i: int,
    takes: dict[str, int],
    values: dict[str, list[str]] | None = None,
) -> int:
    """The index of the first word from `i` on that is neither an option nor an option's
    value, past a `--` that ends the options.

    A short-option cluster is read left to right as getopt reads it: in `-fo FILE` the `o`
    takes a value and is the last letter, so FILE is its value, while in `-oL` the `L` is.
    When `values` is given, each one-word value skipped is appended under its option: FILE
    under `-o`, and the `v` of `--opt=v` under `--opt`.
    """
    while i < len(argv) and argv[i].startswith("-") and len(argv[i]) > 1:
        word = argv[i]
        i += 1
        if word == "--":
            break
        option = None
        if word in takes:
            option = word
        elif word.startswith("--"):
            name, eq, value = word.partition("=")
            if eq and values is not None:
                values.setdefault(name, []).append(value)
        else:
            for j, letter in enumerate(word[1:], 2):
                if f"-{letter}" in takes:
                    if j == len(word):
                        option = f"-{letter}"
                    break
        if option is not None:
            if values is not None and takes[option] == 1 and i < len(argv):
                values.setdefault(option, []).append(argv[i])
            i += takes[option]
    return i


def _runner_command(argv: list[str], values: dict[str, list[str]] | None = None) -> int | None:
    """The index of the word the runner `argv` runs as its command (`uv run --with foo X`),
    or None when `argv` starts no runner mode that execs a program. `values` collects the
    runner's option values as `_past_options` does."""
    head = posixpath.basename(argv[0])
    for prefix, takes in _RUNNER_ARGS.items():
        if prefix[0] != head:
            continue
        i = 1
        seen: dict[str, list[str]] = {}
        for word in prefix[1:]:
            i = _past_options(argv, i, takes, seen)
            if i >= len(argv) or argv[i] != word:
                break
            i += 1
        else:
            i = _past_options(argv, i, takes, seen)
            if values is not None:
                values.update(seen)
            return i
    return None


def _option_values(argv: list[str]) -> set[int]:
    """The indices in `argv` of the separate values the executor `argv[0]` takes for its own
    options, read as `_past_options` reads them: `-f FMT` and the `FMT` of `-qf FMT`. A
    glued value (`-n5`, `--signal=KILL`) is part of its option's word and is not listed."""
    takes, _ = _EXECUTOR_ARGS[posixpath.basename(argv[0])]
    found: set[int] = set()
    i = 1
    while i < len(argv) and argv[i].startswith("-") and len(argv[i]) > 1:
        word = argv[i]
        i += 1
        if word == "--":
            break
        option = word if word in takes else None
        if option is None and not word.startswith("--"):
            for j, letter in enumerate(word[1:], 2):
                if f"-{letter}" in takes:
                    option = f"-{letter}" if j == len(word) else None
                    break
        if option is not None:
            found.update(range(i, min(i + takes[option], len(argv))))
            i += takes[option]
    return found


def _executor_command(argv: list[str]) -> int:
    """The index of the word the executor `argv[0]` runs as its command, past its options,
    their values, its leading plain arguments and, for env, its assignments."""
    takes, plain = _EXECUTOR_ARGS[posixpath.basename(argv[0])]
    i = _past_options(argv, 1, takes)
    if posixpath.basename(argv[0]) == "env":
        while i < len(argv) and _ASSIGNMENT.match(argv[i]):
            i += 1
    return i + plain


def _command_tails(argv: list[str]) -> list[list[str]]:
    """The commands the executor or runner `argv` runs, each from its command word on:
    `env X a` runs `X a`, and `find . -exec X {} +` runs `X {} +`. Empty when `argv` is
    neither."""
    name = posixpath.basename(argv[0])
    runner = _runner_command(argv)
    if name == "find":
        return [argv[i + 1 :] for i, w in enumerate(argv) if w in _FIND_EXEC]
    if runner is not None:
        return [argv[runner:]]
    if name in _EXECUTOR_ARGS:
        return [argv[_executor_command(argv) :]]
    return []


def _runs_variable(argv: list[str]) -> bool:
    """Whether the executor or runner chain `argv` runs a command only an expansion names:
    `env $X`, `timeout 5 nice "$X"`, `find . -exec $X {} +`, `uv run --with foo "$X"`. An
    expansion in an option value, a leading plain argument or the command's own arguments
    names nothing, so `timeout "$T" git log "$REV"`, `find . -name "$P"` and `uv run pytest
    -k "$K"` run no variable."""
    return any(
        tail and (_names_by_expansion(tail[0]) or _runs_variable(tail))
        for tail in _command_tails(argv)
    )


def _runner_payloads(argv: list[str]) -> list[str]:
    """The shell command lines an npm runner in the chain `argv` runs from `-c` or `--call`:
    `npx -c 'eslint .'`, `env npm exec --call="$X"`. npm hands that value to a shell, so it
    has a command position of its own, which the runner's command word does not show."""
    values: dict[str, list[str]] = {}
    found: list[str] = []
    if posixpath.basename(argv[0]) in ("npx", "npm") and _runner_command(argv, values) is not None:
        found = [v for option in _NPM_PAYLOAD_OPTIONS for v in values.get(option, [])]
    for tail in _command_tails(argv):
        if tail:
            found += _runner_payloads(tail)
    return found


def _segment_sudo(
    text: str,
    heredocs: tuple[str, ...],
    depth: int,
    nested: bool,
    quoted: tuple[bool, ...] = (),
) -> int:
    """The rank of what one segment runs: an escalator other than the one allowed command
    line, a command word only an expansion names, or neither. The allowed line counts only
    as a whole top-level segment: inside a payload or a substitution it is refused too.
    `quoted` holds whether each heredoc's delimiter is quoted, as the parse reports it."""
    # Bash joins a backslash-newline before it splits words; shlex would keep the newline in
    # the word, so `sudo\<newline> -n true` would read as a command named "sudo\n".
    joined = text.replace("\\\n", "")
    # shlex splits on the parentheses of `$( )`, so `git log $(git merge-base A B)..B` would
    # read as three commands, the last named `..B`. Each substitution stands as one word that
    # still reads as an expansion, so `$(which sudo) -n true` keeps a variable command word.
    # `_sudo_text` checks the inner commands from `parse`'s substitutions.
    joined = mask_substitutions(joined, _SUB_PLACEHOLDER) or joined
    lex = shlex.shlex(joined, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        words = list(lex)
    except ValueError:
        return _SUDO_ESCALATES if _loose_hit(text) else _SUDO_CLEAN
    cmds, redirected, here = _command_lines(words)
    # A closed-shape Python program that provably starts no process (`_inert_program`) holds
    # `sudo` only as text it writes or compares, so its word search is skipped.
    source = _python_source(words, heredocs) if len(cmds) == 1 else None
    inert_source = _inert_program(source, _heredoc_program_expands(source, heredocs, quoted))
    # Bash expands no brace inside quotes, and shlex has removed the quotes by the time a
    # word reaches the brace check. A brace list counts only when one survives in the
    # segment with every quoted character blanked: a Python heredoc body read as shell has
    # a triple-quoted string whose `{a, b}` is one quoted word, while `{sudo,sh,-c,'id'}`
    # keeps its braces and commas outside the quotes.
    bare = _unquoted(joined)
    brace_unquoted = bare is None or _BRACE_LIST.search(bare) is not None
    found = _SUDO_CLEAN
    for cur in cmds:
        skip = 0
        while skip < len(cur) and (cur[skip] in _KEYWORDS or _ASSIGNMENT.match(cur[skip])):
            skip += 1
        argv = cur[skip:]
        if not argv:
            continue
        name = posixpath.basename(argv[0])
        # A command word built by expansion, brace or glob could spell an escalator. A brace
        # list or glob that matches one is reported as the escalator it spells; a variable or
        # substitution is refused under its own message, since it names no escalator itself.
        variable = _names_by_expansion(argv[0])
        spelled = (brace_unquoted and _BRACE_LIST.search(name)) or (
            any(c in name for c in "*?[") and any(fnmatch.fnmatchcase(e, name) for e in _ESCALATORS)
        )
        if name in _ESCALATORS or spelled or variable:
            allowed = (
                not nested
                and argv[0] == "sudo"
                and skip == 0
                and len(cmds) == 1
                and not redirected
                and not here
                and not heredocs
                and argv[1:3] == ["-n", SUDO_WRAPPER]
                and all(_SUDO_ARG.match(a) for a in argv[3:])
            )
            if not allowed:
                if name in _ESCALATORS or spelled:
                    return _SUDO_ESCALATES
                found = _SUDO_VARIABLE
            continue
        interpreter = _runs_interpreter(argv)
        # A runner that starts a shell (`uv run bash -c …`, `npx sh -c …`) passes its argv on
        # as an executor does. A runner that starts no shell is not searched: `pytest -k
        # 'sudo and x'` would read as a shell payload.
        runs_shell = name in _HOST_RUNNERS and any(
            posixpath.basename(w) in _SHELLS for w in argv[1:]
        )
        # A runner's command word is checked here, before the executor gate below: past it,
        # every word is searched for an escalator, so `uv run pytest -k sudo` would be refused.
        if _runner_command(argv) is not None and _runs_variable(argv):
            found = max(found, _SUDO_VARIABLE)
        for payload in _runner_payloads(argv):
            found = max(found, _sudo_text(payload, depth + 1, True))
            if found == _SUDO_ESCALATES:
                return found
        if not (interpreter or runs_shell or name in _SHELLS or name in _EXECUTORS):
            continue
        rest = argv[1:]
        if name in ("command", "builtin") and rest[:1] in (["-v"], ["-V"], ["-pv"], ["-pV"]):
            continue  # a lookup, which runs nothing
        # An executor runs its command word as the shell would run it at command position,
        # so an expansion there is as unresolvable as a bare `$X -n true`.
        if _runs_variable(argv):
            found = max(found, _SUDO_VARIABLE)
        # A Python script's own arguments are data: `findings.py open --title "…sudo…"`
        # names the word without running it. Its stdin heredoc is still searched below.
        start = _script_arguments_start(argv) if interpreter else None
        if start is not None:
            rest = argv[1:start]
        # An executor's own option value is data: `/usr/bin/time -f "$f %es"` is a format
        # string, not a command line. env is left out, since its -S value is a payload.
        values = _option_values(argv) if name in _EXECUTOR_ARGS and name != "env" else set()
        rest = [tok for i, tok in enumerate(rest, 1) if i not in values]
        for tok in [] if inert_source else rest:
            if _loose_hit(tok) if interpreter else posixpath.basename(tok) in _ESCALATORS:
                return _SUDO_ESCALATES
            # env -S 'sudo -n true' glues its payload to the option; bash -c, eval and
            # timeout pass theirs as one word with a space in it.
            payload = tok.removeprefix("--split-string=").removeprefix("-S")
            if not interpreter and (payload != tok or any(c in tok for c in " \t\n")):
                found = max(found, _sudo_text(payload, depth + 1, True))
                if found == _SUDO_ESCALATES:
                    return found
        bodies = (*heredocs, *here)
        # An interpreter's heredoc or here-string is its program, not shell, so it gets the
        # word search its `-c` argument gets. The shell parse finds no command position in
        # `os.system('sudo id')`, and it reads a Python dict literal `{"a": [1, 2]}` as a
        # brace expansion that could spell sudo.
        if interpreter:
            if not inert_source and any(_loose_hit(body) for body in bodies):
                return _SUDO_ESCALATES
        else:
            for body in bodies:
                found = max(found, _sudo_text(body, depth + 1, True))
                if found == _SUDO_ESCALATES:
                    return found
    return found


_CASE_HEAD = re.compile(r"\s*(?:(?:do|then|else|elif|\{|!)\s+)*case\s+\S*\s*in(?=\s|$)")
_CASE_END = re.compile(r"\s*esac(?=[\s;&|)]|$)")
# A case pattern up to its `)`: one word, an optional `(` before it. A word with a space in it
# is no pattern, so `(true; su*)` keeps `su*` as a command word.
_CASE_PATTERN = re.compile(r"\s*\(?\s*[^\s()]*\s*\)")
_CASE_ALTERNATIVE = re.compile(r"\s*\(?\s*[^\s()]*\s*")


def _case_arms(segments: tuple[Segment, ...], nested: bool):
    """Each segment as `(text, heredocs, heredoc_quoted, nested)` for the sudo check, with case
    patterns cut.

    The segmenter cuts `case x in a) true;; *) y;; esac` at each `;`, so `*) y` would reach
    the check with the glob `*` as its command word, and `*` matches `sudo`. This walks the
    segments of one parse level with the case state bash keeps: after `case W in` and after
    `;;`, `;&` or `;;&`, a pattern comes before the arm's command, and a `|` between patterns
    cuts a segment too. Only that pattern is dropped; the arm's command is checked, as nested,
    so the one allowed sudo line is refused inside an arm. A segment the state does not
    explain is checked whole, which over-refuses.
    """
    depth = 0
    expect = False
    prev_sep = ""
    for seg in segments:
        sep, prev_sep = prev_sep, seg.sep
        masked = mask_substitutions(seg.text, _SUB_PLACEHOLDER) or seg.text
        bare = _unquoted(masked)
        if bare is None or (depth == 0 and not _CASE_HEAD.match(bare)):
            yield seg.text, seg.heredocs, seg.heredoc_quoted, nested
            continue
        if not bare.strip():
            # `;;` is two `;` cuts around an empty segment; `;&` and `;;&` end in `&`.
            if depth and sep == ";" and seg.sep in (";", "&"):
                expect = True
            continue
        if _CASE_END.match(bare):
            depth -= 1
            expect = False
            yield seg.text, seg.heredocs, seg.heredoc_quoted, nested
            continue
        pos = 0
        while True:
            head = _CASE_HEAD.match(bare, pos)
            if head:
                depth += 1
                expect = True
                pos = head.end()
            if not expect:
                break
            pattern = _CASE_PATTERN.match(bare, pos)
            if pattern:
                expect = False
                pos = pattern.end()
                continue
            rest = bare[pos:]
            if not rest.strip() or (seg.sep == "|" and _CASE_ALTERNATIVE.fullmatch(rest)):
                pos = len(bare)
            break
        if masked[pos:].strip():
            yield masked[pos:], seg.heredocs, seg.heredoc_quoted, True


def _sudo_text(text: str, depth: int = 0, nested: bool = False) -> int:
    """The highest rank anything in `text`, read as shell, reaches: an escalator other than
    the one allowed line, a command word only an expansion names, or neither. A command the
    parser refuses is searched word by word instead, which over-refuses."""
    if depth > 4:
        return _SUDO_ESCALATES
    p = parse(text)
    if not p.ok:
        return _SUDO_ESCALATES if _loose_hit(text) else _SUDO_CLEAN
    found = _SUDO_CLEAN
    for rank in itertools.chain(
        (_segment_sudo(t, h, depth, arm, q) for t, h, q, arm in _case_arms(p.segments, nested)),
        (_sudo_text(sub, depth, True) for sub in p.substitutions),
    ):
        found = max(found, rank)
        if found == _SUDO_ESCALATES:
            break
    return found


# DECIDED (2026-10-24, approved): a variable command word whose value the same command sets
# to a literal is judged as that literal, never allowed as a variable. `F="uv run …"; $F x`
# drew 24 refusals in a week although the message says to spell the command out. Each
# resolved rewrite goes back through `_sudo_text`, so `S=sudo; $S id` is refused as sudo.
# Resolution gives up, and the variable refusal stands, on anything that could change a
# variable the text does not show: a heredoc, an IFS assignment, a function definition, or
# a command that can set any name (`eval`, `source`, `trap`, a `-n` nameref, ...). A name
# that `read`, `export`, `printf -v` and their kind set, or that an assignment sets after
# `&&` or `||`, in a pipeline or background job, or inside a compound command, is left
# unresolved.
_VAR_REF = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
# A value is literal when nothing in it expands, globs or quotes. A leading `$PWD/`,
# `$HOME/`, `$TMPDIR/` or `$CLAUDE_JOB_DIR/` is allowed, since it only moves the directory
# and leaves the basename, which is what the boundary reads, literal.
_DIR_PREFIX = re.compile(r"^\$\{?(PWD|HOME|TMPDIR|CLAUDE_JOB_DIR)\}?/")
_LITERAL_VALUE = re.compile(r"[^$`*?\[\]{}\"'\\~]*")
# A command that can set a name its words never show gives up resolution altogether; one
# that sets only names its words spell stops resolving those names. A `-n` nameref on the
# second kind makes it the first.
_VAR_SETTERS = frozenset(
    {
        "source", ".", "eval", "set", "alias", "exec", "trap", "builtin", "command",
        "enable", "coproc",
    }
)  # fmt: skip
_NAME_SETTERS = frozenset(
    {
        "read", "readarray", "mapfile", "declare", "typeset", "local", "export",
        "readonly", "unset", "getopts", "let", "printf",
    }
)  # fmt: skip
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_OPENERS = frozenset({"(", "{", "if", "for", "while", "until", "case", "select"})
_CLOSERS = frozenset({")", "}", "fi", "done", "esac"})
_MAX_VARIANTS = 8


def _literal_value(word: str) -> str | None:
    """The literal value of the shlex word `word`, or None when part of it would expand."""
    value = _DIR_PREFIX.sub("/expanded/", word)
    return value if _LITERAL_VALUE.fullmatch(value) else None


def _literal_variants(command: str) -> list[str]:
    """Rewrites of `command` in which each `$NAME` the command itself set to a literal is
    replaced by that value, one rewrite per value of each literal `for NAME in …` list, at
    most `_MAX_VARIANTS`. A reference in single quotes is left alone, as the shell leaves
    it; one in double quotes takes the value as is, and a bare one takes it word-split.
    Empty when nothing can be resolved safely (the DECIDED comment above lists when)."""
    if "<<" in command or re.search(r"\bIFS=|\w\s*\(\)", command):
        return []
    p = parse(command)
    if not p.ok or p.substitutions:
        return []
    fixed: dict[str, tuple[int, str]] = {}
    loops: list[tuple[str, int, list[str]]] = []
    poisoned: set[str] = set()
    cursor = depth = 0
    after = ";"
    for seg in p.segments:
        words = _words(seg.text)
        at = command.find(seg.text.strip(), cursor)
        if words is None or at < 0:
            return []
        cursor = at + len(seg.text.strip())
        # `then S=sudo` assigns as surely as `S=sudo`, but only when its branch runs, so the
        # keywords and a subshell's `(` ahead of a segment's command are read past, and an
        # assignment behind one is not certain.
        lead = 0
        while lead < len(words) and (words[lead] in _KEYWORDS or words[lead] == "("):
            lead += 1
        cmd = words[lead:]
        head = cmd[0] if cmd else ""
        # The builtin a segment runs sits past any prefix assignment and a `time`, so
        # `A=1 read X` and `time read X` set X as `read X` does.
        run = 0
        while run < len(cmd) and (_ASSIGNMENT.match(cmd[run]) or cmd[run] in ("time", "-p", "--")):
            run += 1
        builtin = cmd[run] if run < len(cmd) else ""
        if builtin in _VAR_SETTERS or (
            builtin in _NAME_SETTERS
            and any(w[:1] == "-" and "n" in w[1:] for w in cmd[run + 1 :])
            and builtin not in ("read", "printf")
        ):
            return []
        # A segment after `&&` or `||` may not run, and a pipeline stage or a background
        # job runs in a subshell, so an assignment in one is not certain. A `;` or newline
        # ends that: what follows it runs, in this shell.
        conditional = after in ("&&", "||", "|", "&") or seg.sep in ("|", "&")
        after = seg.sep
        top = not conditional and depth == 0 and lead == 0
        if builtin in _NAME_SETTERS:
            for w in cmd:
                for name in _NAME.findall(w.split("=", 1)[0]):
                    poisoned.add(name)
                    fixed.pop(name, None)
        elif head == "for" and len(cmd) >= 3 and cmd[2] == "in":
            values = [_literal_value(w) for w in cmd[3:]]
            fixed.pop(cmd[1], None)
            if top and cmd[3:] and None not in values and cmd[1] not in poisoned:
                loops.append((cmd[1], cursor, [v for v in values if v is not None]))
            else:
                poisoned.add(cmd[1])
        elif cmd and all(_ASSIGNMENT.match(w) for w in cmd):
            # `S+=o` and `S[0]=x` change S without setting it to the word's value.
            for w in cmd:
                name = _NAME.match(w).group()
                value = _literal_value(w.partition("=")[2])
                plain = _PLAIN_ASSIGNMENT.match(w)
                if top and plain and value is not None and name not in poisoned:
                    fixed[name] = (cursor, value)
                else:
                    poisoned.add(name)
                    fixed.pop(name, None)
        else:
            # Any other assignment-shaped word, such as a case arm's `x) S=sudo` or a prefix
            # assignment, may or may not change the name, so it stops resolving it.
            for w in words:
                if _ASSIGNMENT.match(w):
                    poisoned.add(_NAME.match(w).group())
                    fixed.pop(_NAME.match(w).group(), None)
        depth = max(
            0, depth + sum(w in _OPENERS for w in words) - sum(w in _CLOSERS for w in words)
        )
    # A name a loop and a later assignment both set has two values at once; resolve neither.
    both = {loop[0] for loop in loops} & set(fixed)
    loops = [loop for loop in loops if loop[0] not in poisoned | both]
    fixed = {name: v for name, v in fixed.items() if name not in both}
    if not fixed and not loops:
        return []
    combos: list[dict[str, tuple[int, str]]] = [dict(fixed)]
    for name, start, values in loops:
        combos = [{**c, name: (start, v)} for c in combos for v in values]
        if len(combos) > _MAX_VARIANTS:
            return []
    return [_substitute(command, binding) for binding in combos]


def _substitute(command: str, binding: dict[str, tuple[int, str]]) -> str:
    """`command` with each reference to a bound name after its binding point replaced, by
    the quote rules `_literal_variants` states."""
    out: list[str] = []
    quote = ""
    i = 0
    while i < len(command):
        c = command[i]
        if c == "\\" and quote != "'":
            out.append(command[i : i + 2])
            i += 2
            continue
        if c in "\"'" and quote in ("", c):
            quote = "" if quote else c
        m = _VAR_REF.match(command, i) if c == "$" and quote != "'" else None
        name = m and (m.group(1) or m.group(2))
        if m and name in binding and i >= binding[name][0]:
            value = binding[name][1]
            out.append(value if quote == '"' else shlex.join(value.split()))
            i = m.end()
            continue
        out.append(c)
        i += 1
    return "".join(out)


def sudo_boundary(sc: Scan, target: str) -> Verdict | None:
    rank = _sudo_text(sc.command)
    if rank == _SUDO_VARIABLE and (variants := _literal_variants(sc.command)):
        rank = max(map(_sudo_text, variants))
    if rank == _SUDO_ESCALATES:
        return Verdict("deny", "sudo-boundary", SUDO_MSG)
    if rank == _SUDO_VARIABLE:
        return Verdict("deny", "sudo-boundary", SUDO_VARIABLE_MSG)
    return None


# --- the decision ------------------------------------------------------------------------------

# Bash order (:625-1142). The first match wins and carries its message; later tasks append.
RULES: tuple[Rule, ...] = (
    remote,
    rm_root,
    force_push,
    push_main,
    gh_api,
    curl_pipe,
    substitution_download,
    write_secrets_file,
    fork_bomb,
    kill_by_pattern,
    pipe_to_shell,
    disk_wipe,
    secret_readers,
    secret_interpreter,
    secret_env,
    sops_decrypt,
    git_sops_diff,
    systemctl_env,
    docker_inspect,
    write_targets,
    inplace_edit,
    terraform,
    force_push_flag,
    push_config,
    push_no_verify,
    config_write,
    machine_config_write,
    sudo_boundary,
)


def deny(command: str, cwd: str = "", env: Mapping[str, str] | None = None) -> Verdict:
    """The bash's decision for one command. `cwd` is accepted for the hook signature the
    spec names and is unused: no rule in the bash reads the working directory. `env`
    supplies HOME for the written-out home path (:595-598), and CLAUDE_JOB_DIR and TMPDIR
    for the scratch directories a secret-named fixture may be written into."""
    if not command:  # :23
        return NONE
    home = (env or {}).get("HOME", "")
    sc = build_scan(command)
    target = rm_target(home)
    for rule in RULES:
        verdict = rule(sc, target)
        if (
            verdict is not None
            and verdict.rule == "write-target"
            and _writes_only_scratch_fixtures(command, env or {}, target)
        ):
            continue
        if verdict is not None:
            # An ask from an earlier rule must not hide a sudo further along the command.
            if verdict.kind != "deny":
                return sudo_boundary(sc, target) or verdict
            return verdict
    return NONE
