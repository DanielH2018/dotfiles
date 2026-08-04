import re

from config_map.render import render
from config_map.scan import build_setup_map

TOKEN_PATTERNS = (
    re.compile(r"mcpsrv_[A-Za-z0-9]+"),
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    # The generic base64-blob catch-all. No "/" in the class: with it, a long enough run of
    # path segments matches, and on macOS one always does -- pytest's tmp_path is
    # /private/var/folders/<2>/<26 chars>/T/..., a 62-character run with no dot or hyphen to
    # break it, and this map renders the paths it found. That made the check fail on every
    # macOS run for a filesystem path, which is the one thing a 40-char base64 match here is
    # guaranteed not to be a secret about. Dropping "/" costs only a blob whose sole 40+ run
    # needs slashes to reach 40; the token shapes this map could actually leak (the two
    # above, plus ghp_/gho_/JWT forms) carry none.
    re.compile(r"\b[A-Za-z0-9+]{40,}={0,2}\b"),
)


def test_no_token_like_strings_in_output(fake_env):
    html = render(build_setup_map())
    for pattern in TOKEN_PATTERNS:
        assert not pattern.search(html), (
            f"found token-like string matching {pattern.pattern!r}"
        )


def test_mcp_server_and_cache_values_never_leak(fake_env):
    html = render(build_setup_map())
    assert "sk-should-not-leak" not in html
    assert "mcpsrv_secretvalue" not in html
    assert "grafana-mcp" not in html
    assert "grafana" in html
    # needs-auth connectors are hidden now, so the name never renders either
    assert "claude.ai Demo Connector" not in html
