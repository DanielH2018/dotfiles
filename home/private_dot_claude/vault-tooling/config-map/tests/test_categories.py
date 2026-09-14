from config_map.scan import build_setup_map, scan_mcp, scan_plugins, scan_scheduled


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


def test_a_malformed_plist_is_skipped_not_fatal(fake_env):
    """One unparseable plist must cost that entry, not the whole scan.

    plistlib raises xml.parsers.expat.ExpatError on malformed XML, and that is
    neither an OSError nor a ValueError — so the original guard let it escape.
    This is not hypothetical: a scheduled job's header comment contained a
    double hyphen, which is illegal inside an XML comment. plutil -lint read the
    file as OK and launchd ran it happily for weeks; the crash surfaced only
    here, and it blocked a push.
    """
    scheduled_dir = fake_env["claude_dir"] / "scheduled"
    (scheduled_dir / "com.demo.claude.broken.plist").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<plist version="1.0">\n'
        "<dict>\n"
        "  <!-- a comment with a -- double hyphen is not well-formed XML -->\n"
        "  <key>Label</key><string>com.demo.claude.broken</string>\n"
        "</dict>\n"
        "</plist>\n",
        encoding="utf-8",
    )

    names = {item.name for item in scan_scheduled().items}
    assert "com.demo.claude.task" in names, "the valid plist is still reported"
    assert "com.demo.claude.broken" not in names, "the malformed one is skipped"


def test_cascade_nodes_expose_section_headings(fake_env):
    root = build_setup_map().cascade[0]  # user ~/.claude/CLAUDE.md
    heading_texts = [text for _level, text in root.headings]
    assert "Section A" in heading_texts
    assert "Section B" in heading_texts
    assert root.line_count > 0
