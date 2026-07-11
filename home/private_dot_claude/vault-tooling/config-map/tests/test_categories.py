from config_map.scan import build_setup_map, scan_mcp, scan_plugins


def test_disabled_and_unlisted_plugins_are_hidden(fake_env):
    names = {item.name for item in scan_plugins().items}
    assert "demo-plugin" in names  # enabledPlugins -> True
    assert "off-plugin" not in names  # enabledPlugins -> False


def test_enabled_plugin_shows_manifest_description(fake_env):
    demo = next(item for item in scan_plugins().items if item.name == "demo-plugin")
    assert demo.purpose == "demo plugin does useful things"


def test_scan_plugins_note_reports_hidden_count(fake_env):
    note = scan_plugins().note
    assert "1 enabled plugins" in note
    assert "1 disabled/unlisted hidden" in note


def test_needs_auth_mcp_connectors_hidden_local_shown(fake_env):
    mcp = scan_mcp()
    names = {item.name for item in mcp.items}
    assert "grafana" in names
    assert "claude.ai Demo Connector" not in names
    assert "hidden" in mcp.note


def test_cascade_nodes_expose_section_headings(fake_env):
    root = build_setup_map().cascade[0]  # user ~/.claude/CLAUDE.md
    heading_texts = [text for _level, text in root.headings]
    assert "Section A" in heading_texts
    assert "Section B" in heading_texts
    assert root.line_count > 0
