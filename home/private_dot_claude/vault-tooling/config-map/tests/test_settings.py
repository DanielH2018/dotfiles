import json

import pytest

from config_map import scan


def test_layer_present_counts_permissions_and_skill_overrides(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "permissions": {"allow": ["a", "b", "c"], "deny": ["d"], "ask": []},
                "skillOverrides": {"foo": "off"},
            }
        )
    )
    layer = scan._layer_from_settings("user", settings_path)
    assert layer.present is True
    fields = dict(layer.fields)
    assert fields["allow"] == "3"
    assert fields["deny"] == "1"
    assert fields["ask"] == "0"
    assert fields["skillOverrides"] == "foo=off"


def test_layer_absent_when_file_missing(tmp_path):
    layer = scan._layer_from_settings("project", tmp_path / "does-not-exist.json")
    assert layer.present is False
    assert layer.fields == ()


def test_layer_sandbox_and_env_summary(tmp_path):
    settings_path = tmp_path / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "permissions": {"allow": [], "deny": [], "ask": []},
                "sandbox": {
                    "enabled": True,
                    "network": {"allowedDomains": ["a", "b"]},
                    "filesystem": {"allowWrite": ["x"], "denyRead": ["y", "z"]},
                },
                "env": {"EDITOR": "vim", "PAGER": "less"},
                "outputStyle": "Terse",
            }
        )
    )
    layer = scan._layer_from_settings("user", settings_path)
    fields = dict(layer.fields)
    assert "2 allowed domains" in fields["sandbox"]
    assert "1 write paths" in fields["sandbox"]
    assert "2 deny-read paths" in fields["sandbox"]
    assert fields["env"] == "EDITOR, PAGER"
    assert fields["outputStyle"] == "Terse"


def test_scan_settings_layers_order_and_presence(tmp_path, monkeypatch):
    claude_dir = tmp_path / "claudedir"
    claude_dir.mkdir()
    (claude_dir / "settings.json").write_text(json.dumps({"permissions": {"allow": ["x"]}}))

    project_local = tmp_path / "project_local.json"
    project_local.write_text(json.dumps({"permissions": {"allow": ["y", "z"]}}))

    monkeypatch.setattr(scan, "MANAGED_SETTINGS", tmp_path / "absent-managed.json")
    monkeypatch.setattr(scan, "PROJECT_SETTINGS_LOCAL", project_local)
    monkeypatch.setattr(scan, "PROJECT_SETTINGS", tmp_path / "absent-project.json")
    monkeypatch.setattr(scan, "CLAUDE_DIR", claude_dir)

    layers = scan.scan_settings_layers()

    assert [l.name for l in layers] == ["managed", "project-local", "project", "user"]
    assert [l.present for l in layers] == [False, True, False, True]
    assert dict(layers[1].fields)["allow"] == "2"
    assert dict(layers[3].fields)["allow"] == "1"
