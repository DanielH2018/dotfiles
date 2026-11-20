"""Two families of CLI subcommand that no allow or ask rule reads by its words.

A settings rule matches a command by its prefix, so `gh auth status *-t*` reads one flag in
one position and nothing reads `gh auth token` at all. `cli_verb` finds the subcommand
words wherever the options sit, behind a leader such as `env` or `timeout`, inside a
`sh -c` string and inside a substitution.

`CREDENTIAL` is a command that prints a credential to its output, which is the transcript:
`gh auth token`, a cloud CLI's `print-access-token`, `kubectl get secret -o yaml`. The
deny rules already refuse the other ways a secret reaches the transcript (`sops -d`,
`printenv TOKEN`, `docker inspect` of an environment), so this one is refused as well. A
substitution that is the whole value of an assignment is left alone: `T=$(gh auth token)`
and `GH_TOKEN=$(gh auth token) cmd` hand the value on without printing it.

`CLAUDE_SETTINGS` is a `claude` subcommand that rewrites Claude Code's own settings,
plugins, MCP servers, login or binary: `claude plugin install`, `claude mcp add`, `claude
update`. An Edit of `~/.claude/settings.json` is in the ask tier, so these ask too.
DECIDED: the `plugin` and `mcp` groups ask by default and pass only the subcommands in
`_PLUGIN_READS` and `_MCP_READS`, so a subcommand a later release adds asks until it is
listed.
"""

import posixpath
import re
import shlex
from collections.abc import Iterator

from claude_guard.segment import parse

CREDENTIAL = "credential-print"
CLAUDE_SETTINGS = "claude-settings-write"

_LEADERS = frozenset(
    {"env", "command", "exec", "nohup", "time", "nice", "timeout", "stdbuf", "xargs", "sudo"}
)
_TEXT_RUNNERS = frozenset({"sh", "bash", "zsh", "dash", "eval", "ssh", "hl", "su", "watch"})
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
# `NAME=$(…)`, quoted or not, with no nested parenthesis: the value is captured, not printed.
_CAPTURED = re.compile(r"""\b[A-Za-z_][A-Za-z0-9_]*=(")?\$\([^()]*\)(?(1)")(?=\s|;|&|$)""")

_SHOW_TOKEN = re.compile(r"-[A-Za-su-z]*t[A-Za-z]*|--show-token")
_SECRET_KEY = re.compile(r"secret|token|password|_auth", re.IGNORECASE)
_KUBECTL_DATA = re.compile(r"(yaml|json)$|jsonpath|go-template|template|custom-columns")
_KUBECTL_SAFE_PATH = re.compile(r"[^{]*\{\.metadata[^{}]*\}[^{]*")
_PASSWORD_FLAG = re.compile(r"-[A-Za-z]*[wg][A-Za-z]*")

_STS_TOKENS = frozenset(
    {"get-session-token", "get-federation-token", "assume-role", "assume-role-with-web-identity"}
)
_PLUGIN_READS = frozenset({"list", "details", "validate", "help", "eval", "test", "tag"})
_MARKETPLACE_READS = frozenset({"list", "help"})
_MCP_READS = frozenset({"list", "get", "help", "serve"})
_CLAUDE_WRITERS = frozenset({"install", "update", "upgrade", "import", "purge"})


def _has(words: list[str], *wanted: str) -> bool:
    """Whether `wanted` appear in order among the first five non-option `words`."""
    head = iter(words[:5])
    return all(any(w == want for w in head) for want in wanted)


def _output_format(args: list[str]) -> str:
    for i, a in enumerate(args):
        if a in ("-o", "--output") and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--output="):
            return a.split("=", 1)[1]
        if a.startswith("-o") and len(a) > 2:
            return a[2:].lstrip("=")
    return ""


def _prints_credential(name: str, args: list[str]) -> bool:
    words = [a for a in args if not a.startswith("-")]
    if name in ("gh", "glab"):
        shown = any(_SHOW_TOKEN.fullmatch(a) for a in args)
        return _has(words, "auth", "token") or (_has(words, "auth", "status") and shown)
    if name == "gcloud":
        return "auth" in words[:3] and any(re.fullmatch(r"print-.*token", w) for w in words)
    if name == "aws":
        return (
            _has(words, "configure", "export-credentials")
            or (_has(words, "configure", "get") and any(_SECRET_KEY.search(w) for w in words))
            or any(_has(words, group, "get-login-password") for group in ("ecr", "ecr-public"))
            or (words[:1] == ["sts"] and bool(set(words) & _STS_TOKENS))
            or _has(words, "secretsmanager", "get-secret-value")
            or _has(words, "codeartifact", "get-authorization-token")
            or ("ssm" in words[:2] and "--with-decryption" in args)
        )
    if name == "az":
        return _has(words, "account", "get-access-token") or _has(
            words, "keyvault", "secret", "show"
        )
    if name == "kubectl":
        if _has(words, "create", "token"):
            return True
        if _has(words, "config", "view"):
            return "--raw" in args or "--flatten" in args
        gets_secret = "get" in words[:3] and any(
            re.fullmatch(r"secrets?(/.*)?", w) for w in words[:5]
        )
        fmt = _output_format(args)
        return (
            gets_secret
            and _KUBECTL_DATA.search(fmt) is not None
            and not _KUBECTL_SAFE_PATH.fullmatch(fmt.partition("=")[2] or "{")
        )
    if name == "npm":
        return _has(words, "token") or (
            _has(words, "config", "get") and any(_SECRET_KEY.search(w) for w in words)
        )
    if name == "git":
        return _has(words, "credential", "fill") or any(
            w.startswith("credential-") for w in words[:1]
        )
    if name == "claude":
        return words[:1] == ["setup-token"]
    if name == "vault":
        return _has(words, "print", "token") or _has(words, "kv", "get") or words[:1] == ["read"]
    if name == "op":
        return words[:1] == ["read"] or (_has(words, "item", "get") and "--reveal" in args)
    if name == "secret-tool":
        return words[:1] == ["lookup"]
    if name == "security":
        finds = words[:1] in (["find-generic-password"], ["find-internet-password"])
        return finds and any(_PASSWORD_FLAG.fullmatch(a) for a in args)
    return False


def _writes_claude_settings(args: list[str]) -> bool:
    words = [a for a in args if not a.startswith("-")]
    if not words:
        return False
    group, rest = words[0], words[1:]
    if group in ("plugin", "plugins"):
        if rest[:1] == ["marketplace"]:
            return bool(rest[1:]) and rest[1] not in _MARKETPLACE_READS
        return bool(rest) and rest[0] not in _PLUGIN_READS
    if group == "mcp":
        return bool(rest) and rest[0] not in _MCP_READS
    if group == "auth":
        return rest[:1] in (["login"], ["logout"])
    if group == "auto-mode":
        return "reset" in rest
    return group in _CLAUDE_WRITERS


def _commands(text: str, depth: int = 0) -> Iterator[list[str]]:
    """Each command `text` runs, as its words from the command name on."""
    p = parse(text)
    if not p.ok or depth > 3:
        return
    for body in [seg.text for seg in p.segments] + list(p.substitutions):
        try:
            words = shlex.split(body)
        except ValueError:
            continue
        i = 0
        while i < len(words):
            w = words[i]
            name = posixpath.basename(w)
            if _ASSIGNMENT.match(w) or name in _LEADERS or w.startswith("-") or w.isdigit():
                i += 1
                continue
            if name in _TEXT_RUNNERS:
                for a in words[i + 1 :]:
                    if " " in a:
                        yield from _commands(a, depth + 1)
            yield [name, *words[i + 1 :]]
            break


def cli_verb(command: str) -> str | None:
    """`CREDENTIAL` when a command in `command` prints a credential, `CLAUDE_SETTINGS` when
    one rewrites Claude Code's own configuration, else None."""
    found = None
    for argv in _commands(_CAPTURED.sub("captured=1", command)):
        if _prints_credential(argv[0], argv[1:]):
            return CREDENTIAL
        if argv[0] == "claude" and _writes_claude_settings(argv[1:]):
            found = CLAUDE_SETTINGS
    return found
