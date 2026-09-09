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
and protected-file-write arms, and the --force upgrade.

The regexes are the bash's EREs with two textual substitutions (`_ere`): `[:space:]` → `\\s`
and `[:alnum:]` → `a-zA-Z0-9`, both inside bracket expressions where Python has no POSIX
classes. `\\b` and `\\s` are the same GNU extensions in both engines. ERE's leftmost-longest
rule and Python's leftmost-first differ only in WHICH match is chosen, never in whether one
exists, and every use here is a boolean search except the upgrade's `re.sub`, which is
anchored on literals.
"""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from claude_guard.segment import parse


@dataclass(frozen=True, slots=True)
class Verdict:
    kind: str  # "deny" | "ask" | "allow" | "none"
    rule: str  # a fixed literal, never text from the command
    reason: str  # the message the bash prints; "" for allow and none
    updated_command: str | None = None  # the --force upgrade (:1132)
    context: str | None = None  # its additionalContext (:1138)


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


def build_scan(command: str) -> Scan:
    scan = normalize(command)
    p = parse(command)
    if not p.ok:
        return Scan(command, scan, scan, scan, False)
    members = [normalize(seg.text) for seg in p.segments]
    members += [normalize(sub) for sub in p.substitutions]
    scanset = "\n".join([scan, *members])
    segset = "\n".join(members) if members else scan
    return Scan(command, scan, scanset, segset, True)


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

_FORCE_FLAG = r"git\s+push.*(--force([ ]|$)|[ ]-f([ ]|$))"
_LEASE = r"\-\-force-with-lease"


def force_push(sc: Scan, target: str) -> Verdict | None:
    """:687-693. The push and its destination must share a segment (bdb_re_pair); the
    --force-with-lease exemption stays whole-string."""
    if not bdb_re(sc.scan, _LEASE) and bdb_re_pair(
        sc.segset, _FORCE_FLAG, r"(^|[[:space:]]|:)(main|master)([[:space:]]|:|\)|`|$)"
    ):
        return Verdict(
            "deny", "force-push-main", "Blocked: force-push to main/master. Use a feature branch."
        )
    if bdb_re(sc.scan, r"git\s+push.*\+\s*(main|master|refs/heads/(main|master))\b"):
        return Verdict(
            "deny",
            "force-push-refspec",
            "Blocked: force-push via +refspec to main/master. Use a feature branch.",
        )
    return None


def push_main(sc: Scan, target: str) -> Verdict | None:
    """:725-728. Any push whose DESTINATION is main/master; `:` is deliberately not a
    terminator here so `main:feature` stays a push to feature."""
    if bdb_re_pair(
        sc.segset,
        r"git[[:space:]]+push\b",
        r"([[:space:]]|:)(refs/heads/)?(main|master)([[:space:]]|\)|`|$)",
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


def pipe_to_shell(sc: Scan, target: str) -> Verdict | None:
    """:849-852. The generic arm, after the kill rules, as in the bash."""
    if bdb_re(sc.scan, PIPE_TO_SHELL):
        return Verdict(
            "deny",
            "pipe-to-shell",
            f"Blocked: piping output to a shell interpreter. {DOWNLOAD_MSG}",
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


def secret_readers(sc: Scan, target: str) -> Verdict | None:
    """:893-944. SCAN split on every `;&|` character (a NAIVE split, deliberately: it is what
    catches a read hidden behind quoting), each piece word-split. The env-dump arm fires
    when the piece matches AND — if the parse succeeded — some quote-aware segment matches
    too (:911-921). For a filter command the pattern argument is dropped before the
    readers arm (:931-938)."""
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
        if head in _FILTERS:
            rest = words[1:]
            while rest:
                if not rest.pop(0).startswith("-"):
                    break
            piece = f"{words[0]} {' '.join(rest)}"
        if bdb_re(piece, rf"\b{READERS}\b.*{SECRET_PATHS}"):
            return Verdict("deny", "secret-read", SECRET_READ_MSG)
    return None


def secret_interpreter(sc: Scan, target: str) -> Verdict | None:
    """:945-949."""
    if bdb_re(
        sc.scan,
        rf"\b(python[0-9.]*|node|deno|bun|perl|ruby|php|Rscript|osascript)\b.*{SECRET_PATHS}",
    ):
        return Verdict(
            "deny",
            "secret-read-interpreter",
            "Blocked: reading a secrets file via an interpreter. Ask the user to share the "
            "specific value needed.",
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
    """:1016-1029."""
    if bdb_re(sc.scan, rf"{BDB_CMD_AT}systemctl\b[^;&|]*(^|[[:space:]])cat([[:space:]]|$)"):
        return Verdict(
            "deny",
            "systemctl-cat",
            "Blocked: `systemctl cat` prints the unit file, Environment= lines and all. Use "
            "`systemctl show -p <Property> <unit>` for a specific field.",
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
    return None


def docker_inspect(sc: Scan, target: str) -> Verdict | None:
    """:1031-1044."""
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

# :1064. SOPS basenames on the WRITE side only (:1057-1063).
WRITE_TARGETS = (
    rf"({SECRET_PATHS}|{SOPS_BASENAMES}|authorized_keys|\.bashrc|\.zshrc|\.bash_profile|"
    r"\.zprofile|\.profile|\.claude/settings\.json|\.claude/hooks/)"
)
# :1081. Editors that unambiguously rewrite the file they name; cp/mv deliberately absent.
BDB_INPLACE = (
    r"((sed|perl)\b[^;&|]*(^|[[:space:]])(-[A-Za-z]*i([[:space:]]|\.)|--in-place)|truncate\b|"
    r"dd\b[^;&|]*(^|[[:space:]])of=)"
)


def write_targets(sc: Scan, target: str) -> Verdict | None:
    """:1065-1067."""
    if bdb_re(
        sc.scan,
        rf"(>>?|tee[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)[[:space:]]*[^[:space:];&|]*"
        rf"{WRITE_TARGETS}",
    ):
        return Verdict(
            "deny",
            "write-target",
            "Blocked: writing to a secrets or shell-startup file. Ask the user to do this "
            "manually.",
        )
    return None


def inplace_edit(sc: Scan, target: str) -> Verdict | None:
    """:1082-1084."""
    if bdb_re(sc.scan, rf"{BDB_CMD_AT}{BDB_INPLACE}[^;&|]*{WRITE_TARGETS}"):
        return Verdict(
            "deny",
            "inplace-edit",
            "Blocked: editing a secrets or shell-startup file in place. A SOPS file must go "
            "through `sops <file>`; ask the user before changing the others.",
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
