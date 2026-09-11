"""A remote status/inspection command run via `hl` or a plain `ssh [user@]host CMD` that is
provably read-only. allow-readonly-remote.sh ported.

"Read-only" is deliberately narrow: the outer (local) command must be exactly `hl` or `ssh`
(no chaining, redirection, or substitution), and the REMOTE command's verb must be on the
allowlist below. docker/systemctl must name a read-only subcommand. Secret-file reads and
log-deleting journalctl flags are refused even when the verb matches, since those exfiltrate
or mutate (:11-15).
"""

import re

from claude_guard.segment import parse
from claude_guard.tables import REMOTE_READONLY_VERBS, SECRET_PATH_RE

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

# :135-138. journalctl reads logs, but these flags delete or rotate them.
_JOURNALCTL_MUTATE = re.compile(r"--(vacuum-(size|time|files)|rotate|flush|sync|relinquish-var)")

# :139-142. dmesg reads the kernel ring buffer, but these flags clear it. A character class
# inside a short cluster, not equality — `-xCy` must refuse, not just a bare `-C`.
_DMESG_MUTATE = re.compile(r"(^| )-[a-zA-Z]*[Cc][a-zA-Z]*($| )|--clear|--read-clear")

# :143-146. ss lists sockets, but -K/--kill closes them. Same shape as dmesg, on K only.
_SS_MUTATE = re.compile(r"(^| )-[a-zA-Z]*K[a-zA-Z]*($| )|--kill")

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

    # :66-71. cmd_parse confirmed the quoting balances, so stripping quote characters and
    # splitting on whitespace is safe. Computed once; every check below reads these tokens.
    stripped = command.replace('"', "").replace("'", "")
    tokens = stripped.split()
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
    remote = tokens[start:]
    verb = remote[0]
    sub = remote[1] if len(remote) > 1 else ""
    third = remote[2] if len(remote) > 2 else ""
    rest = " ".join(remote)

    if _REMOTE_METACHAR.search(rest):
        return False
    if SECRET_PATH_RE.search(rest):
        return False
    if verb == "journalctl" and _JOURNALCTL_MUTATE.search(rest):
        return False
    if verb == "dmesg" and _DMESG_MUTATE.search(rest):
        return False
    if verb == "ss" and _SS_MUTATE.search(rest):
        return False

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
    return False
