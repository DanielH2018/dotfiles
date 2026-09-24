"""A remote status/inspection command run via `hl` or a plain `ssh [user@]host CMD` that is
provably read-only. allow-readonly-remote.sh ported.

"Read-only" is deliberately narrow: the outer (local) command must be exactly `hl` or `ssh`
(no chaining, redirection, or substitution), and the REMOTE command's verb must be on the
allowlist below. docker/systemctl must name a read-only subcommand. Secret-file reads and
log-deleting journalctl flags are refused even when the verb matches, since those exfiltrate
or mutate (:11-15).
"""

import re
import shlex

from claude_guard.checks.remote_guards import GUARDS
from claude_guard.segment import parse
from claude_guard.tables import REMOTE_READONLY_VERBS, SECRET_PATH_RE, TRUSTED_SSH_HOSTS

# :47-64. Out of cmd_parse's scope by design ("this slice deliberately stops at
# segmentation"): redirection (an unquoted `<`/`>` is consumed by the LOCAL shell, not
# passed to the remote command), glob chars (the remote shell expands `*?[]`), backslash
# (kept out of the tokenizer's scope entirely), and a literal newline (inert to cmd_parse
# inside quotes, same as a quoted `;`, but `read -ra` below splits on it like a space, so it
# cannot be deferred to the remote-text recheck the way `;`/`&`/`|` are). Applied to the raw
# COMMAND, unconditionally — including inside quotes ssh will hand to the remote shell.
_RAW_BAN = re.compile(r"[<>{}*?\[\]\\\n]")

# :121-124. Metacharacters on the joined REMOTE text. cmd_parse already proved these are
# locally quoted (harmless to THIS shell), but ssh concatenates argv and hands the string to
# a remote shell that reparses it from scratch — a quoted `;` is still two remote commands.
_REMOTE_METACHAR = re.compile(r"[;&|`$()]")

# :135-146 — the journalctl/dmesg/ss flag arms the bash carried here, and the rg/sensors
# ones server #1898 added beside them, are `remote_guards.GUARDS` entries since server
# #2078: an argv guard the server replays against its own copy, where a regex over the
# joined text ran before the table lookup and sat outside that replay.

# :166-170. Only inspection subcommands are read-only ("ip a", "ip route", "ip addr show");
# anything else ("ip link set", "ip addr add", ...) mutates. An ABSENT third token ("ip a")
# is itself a member of the allowed set.
_IP_THIRD = frozenset({"", "show", "list", "ls", "get"})

# :171-185. docker's nested sub-tables, dispatched here beside the check that reads them
# (tables.py holds only the flat, no-subcommand verbs).
_DOCKER_FLAT = frozenset(
    {
        "ps",
        "logs",
        "images",
        "stats",
        "version",
        "info",
        "top",
        "port",
        "diff",
        "history",
        "events",
        "search",
    }
)
_DOCKER_NESTED: dict[str, frozenset[str]] = {
    "network": frozenset({"ls", "inspect"}),
    "volume": frozenset({"ls", "inspect"}),
    "context": frozenset({"ls", "inspect"}),
    "node": frozenset({"ls", "inspect"}),
    "container": frozenset({"ls", "logs", "top", "stats", "port", "diff"}),
    "image": frozenset({"ls", "history"}),
    "system": frozenset({"df", "info", "events"}),
    "compose": frozenset({"ps", "logs", "images", "top"}),
    "service": frozenset({"ls", "ps", "logs"}),
    "stack": frozenset({"ls", "ps", "services"}),
}
# DECIDED: :172-173. docker inspect/config are deliberately excluded from every docker
# arm above — they print the container/compose Env[], the same secret-dumping shape as
# `env`. Do not add them to _DOCKER_FLAT or any _DOCKER_NESTED value.

# :186-194. show/cat/show-environment print unit `Environment=` values — same
# secret-dumping shape as `env`/`docker inspect`, so they're excluded here too.
# DECIDED: :187-188. systemctl show/cat/show-environment stay off this list for the same
# reason as docker inspect/config above.
_SYSTEMCTL_SUB = frozenset(
    {
        "status",
        "is-active",
        "is-enabled",
        "is-failed",
        "list-units",
        "list-unit-files",
        "get-default",
        "list-timers",
        "list-sockets",
        "list-dependencies",
        "list-jobs",
        "is-system-running",
    }
)


def readonly_remote_safe(command: str) -> bool:
    """:26-199. True only when `command` is a single, unsubstituted `hl`/`ssh` invocation
    whose remote verb (and, where the verb needs one, subcommand) is provably read-only.

    False is "no opinion" everywhere — a parse refusal, an unrecognised wrapper, verb, or
    subcommand, and a metacharacter/secret-path/mutation-flag match are all the same
    fall-through as the bash's unconditional `exit 0` (:198-199).
    """
    if not command:
        return False

    # :42-45. cmd_parse's contract: exactly one segment, no substitution, no heredoc. A
    # parse refusal (unbalanced quote, unclosed substitution) is a refusal, never a skip.
    parsed = parse(command)
    if not parsed.ok or len(parsed.segments) != 1 or parsed.substitutions:
        return False
    if parsed.segments[0].heredocs:
        return False

    if _RAW_BAN.search(command):
        return False

    # :66-71 ported one level deeper (server #1898). The bash stripped every quote character
    # and split on whitespace; that reads the verb correctly but not a program text, and
    # `sed`/`awk` below scan one. `ssh host "sed '1 w /x' f"` reaches the far shell as
    # `sed '1 w /x' f` — a script that writes /x — while quote-stripping reads it as the
    # script `1` and three input files. So the LOCAL shell's tokenization is applied here
    # (one layer of quotes removed, as bash hands ssh its argv), and the remote argv is
    # re-tokenized from the joined text further down, as the far shell does. cmd_parse
    # confirmed the quoting balances and `_RAW_BAN` refused every backslash, so shlex's POSIX
    # mode reads the same words bash would.
    try:
        tokens = shlex.split(command)
    except ValueError:
        return False
    if not tokens:
        return False

    bin_name = tokens[0].rsplit("/", 1)[-1]  # :79. basename, so an absolute path still matches
    if bin_name == "hl":
        start = 1
    elif bin_name == "ssh":
        if len(tokens) > 1 and tokens[1] == "-O":
            # :83-90. `-O check` probes the local multiplexer and runs nothing remote. Only
            # the bare 4-token form; a trailing remote command is a different call.
            return len(tokens) == 4 and tokens[2] == "check" and not tokens[3].startswith("-")
        # :91-104. BatchMode=yes only stops ssh asking for a password; every other option
        # bails, so an option value is never mistaken for the remote verb.
        start = 1
        while start < len(tokens) and tokens[start].startswith("-"):
            tok = tokens[start]
            if tok == "-oBatchMode=yes":
                start += 1
            elif tok == "-o":
                if start + 1 >= len(tokens) or tokens[start + 1] != "BatchMode=yes":
                    return False
                start += 2
            else:
                return False
        if len(tokens) < start + 2:
            return False
        start += 1  # skip past the host
    else:
        return False

    # :108-109. No remote command means an interactive shell — not read-only.
    if len(tokens) <= start:
        return False
    # ssh joins its remaining argv with single spaces and hands that string to the remote
    # shell, which tokenizes it from scratch — so `rest` is exactly the far side's input.
    rest = " ".join(tokens[start:])
    if not rest.strip():
        return False

    if _REMOTE_METACHAR.search(rest):
        return False
    if SECRET_PATH_RE.search(rest):
        return False
    try:
        remote = shlex.split(rest)
    except ValueError:
        return False  # a quote that balanced locally but not remotely
    if not remote:
        return False
    return remote_argv_readonly(remote)


# The verbs `remote_argv_readonly` decides behind a guard rather than by table membership:
# the ip/docker/systemctl sub-tables, and the argv guards in `remote_guards.py`. Exported for
# the server repo's boundary test (#1982), which read the set the package really guards; that
# test went with the server's classifier copy (dotfiles #628).
REMOTE_GUARDED_VERBS: frozenset[str] = frozenset({"ip", "docker", "systemctl"}) | frozenset(GUARDS)


def remote_argv_readonly(remote: list[str]) -> bool:
    """True when a remote argv's verb is read-only by table or passes its guard. The
    verb-level half of `readonly_remote_safe`, factored out so the server repo can replay
    one vector table through this and its own local classifier (server #1898). Carries
    no shape checks: metacharacters, secret paths and the flag-regex guards above are the
    caller's, applied to the joined text before the argv exists.
    """
    if not remote:
        return False
    verb = remote[0]
    sub = remote[1] if len(remote) > 1 else ""
    third = remote[2] if len(remote) > 2 else ""
    if verb in REMOTE_READONLY_VERBS:
        return True
    if verb == "ip":
        return third in _IP_THIRD
    if verb == "docker":
        if sub in _DOCKER_FLAT:
            return True
        return third in _DOCKER_NESTED.get(sub, frozenset())
    if verb == "systemctl":
        return sub in _SYSTEMCTL_SUB
    guard = GUARDS.get(verb)
    return guard(remote) if guard else False


# D1 (docs/plans/2026-09-11-claude-guard-slice-3-cutover.md): trusted_host_safe is a SEPARATE
# function, not a tier of readonly_remote_safe above. That function decides on the VERB and
# has no host filter; this one decides on the HOST and has no verb table — once host and shape
# pass, it allows the entire remote payload, read-only or not (allow-daniel-server.sh:4-6,112).
# It also runs its own quote-state machine rather than claude_guard.segment.parse: the bash
# never used cmd_parse, and reusing readonly_remote_safe's `-O check` / `-o BatchMode=yes`
# option carve-out here would WIDEN a hook that consumes no option at all (:87).


def _local_split_risk(command: str) -> bool:
    """allow-daniel-server.sh:49-73. Character-by-character quote-state machine over the RAW
    command string, judging each character in its quote context rather than by presence alone.

    Outside quotes: `; & | < > ( ) $` `` ` `` or a newline all split the LOCAL command or
    expand locally, and are a risk. Inside double quotes: only `$` and `` ` `` are a risk —
    they still expand locally before ssh ever runs; every other byte, `;` included, is a
    literal byte of the payload handed to the remote shell. Inside single quotes: nothing
    expands, so nothing is a risk. A backslash escapes the next character everywhere except
    inside single quotes, so the pair is consumed together rather than letting `\\"`
    desynchronise the quote tracking. An unterminated quote at end-of-string makes the parse
    untrustworthy and is itself a risk.

    This is the function that lets `ssh daniel-server "cd /repo; git status"` through: a
    regex banning `;` anywhere reintroduces the regression this state machine fixed — that
    exact idiom was 67 of 361 ssh prompts measured over the week of 2026-08-07 (:34-39).
    """
    q = ""
    i = 0
    n = len(command)
    while i < n:
        c = command[i]
        if q == "'":
            if c == "'":
                q = ""
            i += 1
            continue
        if q == '"':
            if c == "\\":
                i += 2
                continue
            if c == '"':
                q = ""
            elif c in "$`":
                return True
            i += 1
            continue
        if c == "\\":
            i += 2
            continue
        if c in "'\"":
            q = c
        elif c in ";&|<>()$`\n":
            return True
        i += 1
    return bool(q)  # :71. an unterminated quote is a risk, not a pass.


def trusted_host_safe(command: str) -> bool:
    """allow-daniel-server.sh:20-112. True only when `command` is a single, plain
    `ssh [user@]HOST ...` invocation to a fully-trusted host, in which case the ENTIRE remote
    payload is allowed — read-only or not (D1, :4-6, :112). False is "no opinion" everywhere
    else: a local-split risk, fewer than three tokens, a non-ssh binary, any option on TOK[1],
    an untrusted or merely-substring-matching host, or a second `ssh`/`hl`/`scp`/`sftp`/`rsync`
    hop anywhere in the payload (:74, :80, :83, :87, :89-95, :106-110).
    """
    if not command:
        return False
    if _local_split_risk(command):
        return False

    # :77-79. Local splitting is ruled out, so quotes are pure grouping and can be stripped.
    stripped = command.replace('"', "").replace("'", "")
    tokens = stripped.split()
    if len(tokens) < 3:  # :80
        return False

    if tokens[0].rsplit("/", 1)[-1] != "ssh":  # :83. basename, so an absolute path still matches
        return False

    # :87. No option is EVER consumed here (unlike readonly_remote_safe's `-O check` /
    # `-o BatchMode=yes` carve-out) — any TOK[1] starting with `-` refuses outright, so an
    # option value is never mistaken for the host and no forwarding/proxy flag rides along.
    if tokens[1].startswith("-"):
        return False

    # :89-95. Exact host match only, `user@` stripped from the FIRST `@` (bash's `${TOK[1]#*@}`
    # removes the shortest leading `*@` match). Substring matching is explicitly ruled out —
    # `daniel-server-backup` and `notdaniel-server` must both refuse.
    host = tokens[1].split("@", 1)[-1]
    if host not in TRUSTED_SSH_HOSTS:
        return False

    # :97-110. Every token from index 2 onward, basename-matched — not just TOK[2] — since a
    # hop can sit mid-payload after a `cd /tmp;` or as an argument to `docker exec`.
    for tok in tokens[2:]:
        if tok.rsplit("/", 1)[-1] in {"ssh", "hl", "scp", "sftp", "rsync"}:
            return False

    return True
