"""A curl that is provably a plain GET/HEAD against an allowlisted host. allow-safe-curl.sh ported.

The option table is an ALLOWLIST (allow-safe-curl.sh:16-29): curl gains options every
release, so an option this module does not name, old or new, is not a decision. Absent on
purpose are --resolve, --connect-to, -x/--proxy, --unix-socket, -K/--config, --next,
-L/--location, every write primitive except `-o /dev/null`, and every read-a-file primitive.
-k/--insecure IS allowed: the host is already pinned and the homelab serves self-signed certs.
"""

import re

from claude_guard.tables import CURL_HOSTS

# :75-76. `o` is admitted ONLY for the literal /dev/null (check_value).
BOOL_SHORT = "sSfiIvkg46N#G"
VALUE_SHORT = "HAmwreXo"

# :204-224.
LONG_BOOL = frozenset(
    {
        "silent",
        "show-error",
        "fail",
        "fail-early",
        "fail-with-body",
        "include",
        "head",
        "verbose",
        "insecure",
        "compressed",
        "globoff",
        "ipv4",
        "ipv6",
        "http1.0",
        "http1.1",
        "http2",
        "http2-prior-knowledge",
        "no-buffer",
        "no-progress-meter",
        "progress-bar",
        "raw",
        "tcp-nodelay",
        "no-keepalive",
        "path-as-is",
        "retry-all-errors",
        "retry-connrefused",
        "get",
    }
)
LONG_VALUE = frozenset(
    {
        "header",
        "user-agent",
        "referer",
        "max-time",
        "connect-timeout",
        "retry",
        "retry-delay",
        "retry-max-time",
        "range",
        "max-filesize",
        "write-out",
        "request",
        "url",
        "expect100-timeout",
        "happy-eyeballs-timeout-ms",
        "data-urlencode",
        "output",
    }
)

# :107-108.
_SPECIAL = frozenset(";&|<>(){}$`\\*?[]\n\r")

# :173-175. Each octet checked numerically so `10.43.0.0.evil.com` cannot pass; the domain
# match is anchored to the END so `daniel-hunter.com.attacker.net` does not match.
_OCTET = r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])"
_CLUSTER_RE = re.compile(rf"^10\.4[23]\.{_OCTET}\.{_OCTET}$")
_DOMAIN_SUFFIX = ".daniel-hunter.com"
_SCHEME_RE = re.compile(r"^[Hh][Tt][Tt][Pp][Ss]?://")


def tokenize(s: str) -> list[str] | None:
    """:87-153. Like scratch.tokenize, except `~` is refused only at the start of a word and
    a backslash inside double quotes escapes only $ ` " \\ and newline, as bash does."""
    tokens: list[str] = []
    state = ""
    cur = ""
    started = False
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        i += 1
        if state == "":
            if c in " \t":
                if started:
                    tokens.append(cur)
                    cur = ""
                    started = False
            elif c == "'":
                state = "single"
                started = True
            elif c == '"':
                state = "double"
                started = True
            elif c in _SPECIAL:
                return None
            elif c == "~":
                if not started:
                    return None
                cur += c
            else:
                cur += c
                started = True
        elif state == "single":
            if c == "'":
                state = ""
            else:
                cur += c
        else:  # double, :120-144
            if c == '"':
                state = ""
            elif c in "$`":
                return None
            elif c == "\\":
                nxt = s[i] if i < n else ""
                if nxt and nxt in '$`"\\\n':
                    cur += nxt
                    i += 1
                else:
                    cur += c
            else:
                cur += c
    if state:
        return None
    if started:
        tokens.append(cur)
    return tokens


def host_allowed(candidate: str) -> bool:
    """:168-177."""
    if candidate in CURL_HOSTS:
        return True
    if _CLUSTER_RE.match(candidate):
        return True
    return candidate.endswith(_DOMAIN_SUFFIX)


def url_ok(url: str) -> bool:
    """:182-202. Authority is everything after the scheme and before the first /?#; any
    userinfo is refused rather than skipped."""
    if not _SCHEME_RE.match(url):
        return False
    rest = url.split("://", 1)[1]
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    if not authority or "@" in authority:
        return False
    if authority.startswith("["):
        host = authority.split("]", 1)[0] + "]"
    else:
        host = authority.split(":", 1)[0]
    port = authority[len(host) :]
    if port:
        if not port.startswith(":"):
            return False
        if not re.fullmatch(r"[0-9]+", port[1:]):
            return False
    return host_allowed(host.lower())


def curl_safe(command: str) -> bool:
    """:266-331. True only when a URL was checked and every option was named."""
    if not command:
        return False
    tokens = tokenize(command)
    if tokens is None or len(tokens) <= 1:
        return False
    if tokens[0].rsplit("/", 1)[-1] != "curl":
        return False

    saw_url = False
    saw_get = False
    saw_data = False

    def check_value(name: str, value: str) -> bool:
        # :235-259. A value starting with @ makes curl read a FILE; refused everywhere.
        nonlocal saw_url, saw_data
        if value.startswith("@"):
            return False
        if name in ("request", "X"):
            return value in ("GET", "HEAD", "get", "head")
        if name == "url":
            if not url_ok(value):
                return False
            saw_url = True
        elif name in ("output", "o"):
            if value != "/dev/null":
                return False
        elif name == "data-urlencode":
            saw_data = True
        return True

    i = 1
    n = len(tokens)
    while i < n:
        tok = tokens[i]
        i += 1
        if tok == "--":
            return False
        if tok.startswith("--") and len(tok) > 2 and "=" in tok[3:]:  # --?*=*
            name, value = tok[2:].split("=", 1)
            if name not in LONG_VALUE or not check_value(name, value):
                return False
        elif tok.startswith("--") and len(tok) > 2:  # --?*
            name = tok[2:]
            if name in LONG_BOOL:
                if name == "get":
                    saw_get = True
                continue
            if name not in LONG_VALUE or i >= n:
                return False
            value = tokens[i]
            i += 1
            if not check_value(name, value):
                return False
        elif tok.startswith("-") and len(tok) > 1:  # -?*
            cluster = tok[1:]
            j = 0
            while j < len(cluster):
                c = cluster[j]
                j += 1
                if c in BOOL_SHORT:
                    if c == "G":
                        saw_get = True
                    continue
                if c not in VALUE_SHORT:
                    return False
                value = cluster[j:]
                if not value:
                    if i >= n:
                        return False
                    value = tokens[i]
                    i += 1
                if not check_value(c, value):
                    return False
                break
        else:
            if not url_ok(tok):
                return False
            saw_url = True

    # :325-329. --data-* without -G is a POST body; this check only speaks for GET/HEAD.
    if saw_data and not saw_get:
        return False
    return saw_url
