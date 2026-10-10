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
exists, and every use here is a boolean search.

One rule is not the bash's. The bash upgraded a `--force`/`-f` push to a feature branch into
`--force-with-lease` and allowed it; `force_push_flag` denies it instead (dotfiles #701), so
this hook and the settings deny rules state one intent.

Two rules have changed since the bash in ways that reach their messages. `pipe_to_shell`
judges each pipeline stage rather than the whole string, so a `|sh` quoted in an argument
that no stage runs as shell is allowed, and its message names an alternative (dotfiles
#801). `secret_readers` drops exclude arguments before it matches, and both secret-read
denials name the words that matched, with the exclude arguments for a recursive search
(dotfiles #802).
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

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
from claude_guard.segment import parse


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


def build_scan(command: str) -> Scan:
    scan = normalize(command)
    p = parse(command)
    if not p.ok:
        return Scan(command, scan, scan, scan, False)
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
    return Scan(command, scan, scanset, segset, True, gits)


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


def rm_root(sc: Scan, target: str) -> Verdict | None:
    """:662-667. Joined flags first, then the separated spelling (rm -r -f, --recursive
    --force); the target check on the second arm is case-SENSITIVE (bdb_re), as the bash."""
    if bdb_rei(sc.scan, _RM_RF_FLAGS + target):
        return Verdict("deny", "rm-root", RM_MSG)
    if (
        bdb_rei(sc.scan, r"\brm\s")
        and bdb_rei(sc.scan, r"(\s-[a-zA-Z]*r|\s--recursive)")
        and bdb_rei(sc.scan, r"(\s-[a-zA-Z]*f|\s--force)")
        and bdb_re(sc.scan, target)
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

GH_API_AT = (
    r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+|"
    r"(command|env|exec|sudo|nohup|nice)[[:space:]]+)*([^[:space:];&|()]*/)?gh[[:space:]]+api\b"
)
GH_HINT = "Read-only gh api is fine; a human runs the mutation."


def gh_api(sc: Scan, target: str) -> Verdict | None:
    """:745-766. Gate on the scan set; the flag arms read SCAN. The method arm folds case."""
    if not bdb_re(sc.scanset, GH_API_AT):
        return None
    if bdb_rei(
        sc.scan,
        r"(^|[[:space:]])(-X|--method)[[:space:]]*=?[[:space:]]*(POST|PUT|PATCH|DELETE)\b",
    ):
        return Verdict(
            "deny",
            "gh-api-method",
            f"Blocked: mutating gh api request (POST/PUT/PATCH/DELETE). {GH_HINT}",
        )
    arms = (
        (
            "gh-api-field-long",
            r"(^|[[:space:]])(--field|--raw-field)([[:space:]]|=)",
            "Blocked: gh api field parameter, which makes the request a POST.",
        ),
        (
            "gh-api-field-short",
            r"(^|[[:space:]])-[a-zA-Z]*[fF]",
            "Blocked: gh api field parameter (-f/-F), which makes the request a POST.",
        ),
        (
            "gh-api-input",
            r"(^|[[:space:]])--input([[:space:]]|=)",
            "Blocked: gh api reading a request body from a file.",
        ),
        (
            "gh-api-graphql",
            r"(^|[[:space:]]|/)graphql\b",
            "Blocked: gh api graphql, which can mutate.",
        ),
    )
    for rule, pattern, message in arms:
        if bdb_re(sc.scan, pattern):
            return Verdict("deny", rule, f"{message} {GH_HINT}")
    return None


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
# reading it here denied `grep -E '(foo|sh)' f | xargs ls` (dotfiles #801).
_SHELL_REPARSE = re.compile(
    _ere(
        r"(^|[^[:alnum:]_])(sh|bash|zsh|ksh|dash|csh|tcsh|fish|ash|mksh|pdksh|yash|osh|eval|"
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


def _pipes_to_shell(command: str) -> bool:
    """Whether some pipeline stage of `command` is a shell. A stage is matched on its own
    normalised text, so a `|sh` quoted inside another stage's argument is not a pipe. A
    segment that re-parses its quoted text (`_SHELL_REPARSE`) or holds a substitution is
    matched whole, with its heredoc bodies; a heredoc fed to anything else is data. A command
    the parse refuses falls back to the whole-string match."""
    p = parse(command)
    if not p.ok:
        return bdb_re(normalize(command), PIPE_TO_SHELL)
    after_pipe = False
    for seg in p.segments:
        text = normalize(seg.text)
        if after_pipe and bdb_re("|" + text, PIPE_TO_SHELL):
            return True
        bare = _unquoted(seg.text)
        whole = bare is None or _SHELL_REPARSE.search(bare) or _SUBSTITUTION.search(seg.text)
        if whole and (bdb_re(text, PIPE_TO_SHELL) or any(map(_pipes_to_shell, seg.heredocs))):
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
    if bdb_re(
        sc.scan,
        r"\|[[:space:]]*([^[:space:]|;&]*/)?(xargs[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?"
        rf"kill{KILL_TAIL}",
    ):
        return Verdict("deny", "pipe-kill", f"Blocked: piping matched PIDs into kill. {KILL_HINT}")
    if bdb_re(sc.command, r"\bkill\b[^;&|]*([<$]\(|`)[^)`]*\b(pgrep|ps)\b"):
        return Verdict(
            "deny",
            "kill-pgrep",
            f"Blocked: kill of a PID found by pattern matching (pgrep/ps). {KILL_HINT}",
        )
    return None


# --- disk wipes (:854-857) -------------------------------------------------------------------


def disk_wipe(sc: Scan, target: str) -> Verdict | None:
    """:855-857, raw command."""
    if bdb_re(sc.command, r"\b(mkfs|dd\s+if=.*of=/dev/|fdisk|parted)\b"):
        return Verdict("deny", "disk-wipe", "Blocked: low-level disk operation.")
    return None


# --- secret reads (:859-949) -------------------------------------------------------------------

# :881. The four key/cert suffixes are anchored on BOTH sides so `.keys()` and a jq
# `\(.key)` do not read as a file (:866-880).
SECRET_PATHS = (
    r"(\.env|\.ssh/|id_rsa|id_ed25519|id_ecdsa|\.aws/credentials|\.aws/config|\.gnupg/|\.netrc|"
    r"\.pypirc|\.npmrc|/secrets/|\.git-credentials|\.kube/config|\.docker/config\.json|"
    r"\.config/gh/hosts\.yml|\.claude/\.credentials\.json|\.claude\.json|/etc/shadow|"
    r"/etc/gshadow|/proc/[^/[:space:]]+/environ|(^|[A-Za-z0-9_~/-])\.(pem|key|p12|pfx)\b)"
)
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


def secret_readers(sc: Scan, target: str) -> Verdict | None:
    """:893-944. SCAN split on every `;&|` character (a NAIVE split, deliberately: it is what
    catches a read hidden behind quoting), each piece word-split. The env-dump arm fires
    when the piece matches AND — if the parse succeeded — some quote-aware segment matches
    too (:911-921). Exclude arguments are dropped, then for a filter command the pattern
    argument (:931-938), before the readers arm. The denial names the words that matched,
    and for a recursive search the exclude arguments that would let it through (#802)."""
    for piece in re.split(r"[;&|]", sc.scan):
        words = piece.split()
        if not words:
            continue
        head = words[0].rsplit("/", 1)[-1]
        if (
            head not in _DOC_LEADERS
            and bdb_re(piece, ENV_DUMP)
            and (not sc.parsed or bdb_re(sc.segset, ENV_DUMP))
        ):
            return Verdict("deny", "env-dump", ENV_DUMP_MSG)
        words = [words[0], *_drop_excludes(words[1:])]
        piece = " ".join(words)
        if head in _FILTERS:
            rest = words[1:]
            while rest:
                if not rest.pop(0).startswith("-"):
                    break
            piece = f"{words[0]} {' '.join(rest)}"
        if bdb_re(piece, rf"\b{READERS}\b.*{SECRET_PATHS}"):
            secrets = _secret_words(piece.split()[1:])
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
    interpreter = r"\b(python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript|osascript)\b"
    if bdb_re(sc.scan, rf"{interpreter}.*{SECRET_PATHS}"):
        return Verdict(
            "deny",
            "secret-read-interpreter",
            "Blocked: reading a secrets file via an interpreter. Ask the user to share the "
            f"specific value needed.{_naming(_secret_words(sc.scan.split()))}",
        )
    return None


# --- decrypting rather than reading (:951-1044) -----------------------------------------------

# :971-972. DECIDED (:958-963): these are their own arms, not SECRET_PATHS entries.
SOPS_BASENAMES = r"(secrets?\.(ya?ml|json|env|ini)|[^[:space:]/]+\.sops\.(ya?ml|json|env|ini))"
SOPS_PATHS = rf"(^|[[:space:]])([^[:space:]]*/)?{SOPS_BASENAMES}\b"
# :983. Command position with an env assignment or an ssh/hl host allowed before the binary.
BDB_CMD_AT = (
    r"(^|[;&|(`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*"
    r"((ssh|hl)[[:space:]]+[^[:space:]]+[[:space:]]+)*"
)


def sops_decrypt(sc: Scan, target: str) -> Verdict | None:
    """:985-992."""
    if bdb_re(
        sc.scan,
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
    """:994-1014. `--stat`, `--name-only`, `--name-status` emit no content and are exempt."""
    if bdb_re(
        sc.scan,
        rf"{BDB_CMD_AT}git\b[^;&|]*(\bdiff\b|\bshow\b|\blog\b[^;&|]*(-p|--patch)\b)[^;&|]*"
        rf"{SOPS_PATHS}",
    ) and not bdb_re(sc.scan, r"(^|[[:space:]])--(stat|name-only|name-status)([[:space:]]|=|$)"):
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
            "`git config <key> <value>`.",
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


def inplace_edit(sc: Scan, target: str) -> Verdict | None:
    """:1099-1101."""
    if bdb_re(sc.scan, rf"{BDB_CMD_AT}{BDB_INPLACE}[^;&|]*{WRITE_TARGETS}"):
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
)


def deny(command: str, cwd: str = "", env: Mapping[str, str] | None = None) -> Verdict:
    """The bash's decision for one command. `cwd` is accepted for the hook signature the
    spec names and is unused: no rule in the bash reads the working directory. `env`
    supplies HOME for the written-out home path (:595-598)."""
    if not command:  # :23
        return NONE
    home = (env or {}).get("HOME", "")
    sc = build_scan(command)
    target = rm_target(home)
    for rule in RULES:
        verdict = rule(sc, target)
        if verdict is not None:
            return verdict
    return NONE
