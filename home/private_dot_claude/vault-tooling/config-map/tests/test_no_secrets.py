import re

from config_map.render import render
from config_map.scan import build_setup_map

TOKEN_PATTERNS = (
    re.compile(r"mcpsrv_[A-Za-z0-9]+"),
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    re.compile(r"\b[A-Za-z0-9+/]{40,}={0,2}\b"),
)


def test_no_token_like_strings_in_output(fake_env):
    html = render(build_setup_map())
    for pattern in TOKEN_PATTERNS:
        assert not pattern.search(html), f"found token-like string matching {pattern.pattern!r}"


def test_mcp_server_and_cache_values_never_leak(fake_env):
    html = render(build_setup_map())
    assert "sk-should-not-leak" not in html
    assert "mcpsrv_secretvalue" not in html
    assert "grafana-mcp" not in html
    assert "grafana" in html
    # needs-auth connectors are hidden now, so the name never renders either
    assert "claude.ai Demo Connector" not in html
