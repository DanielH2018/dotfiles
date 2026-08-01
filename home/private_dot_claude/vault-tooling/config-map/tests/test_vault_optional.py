"""config-map must never error, and never create a vault section, when no vault
is configured/present ($CLAUDE_VAULT_DIR unset or its target missing). See
sources._resolve_vault_root / VAULT_PRESENT and generate.main()'s early-out."""

import importlib

from config_map import sources


def _reload_sources():
    importlib.reload(sources)
    return sources


def test_resolve_vault_root_prefers_env(tmp_path, monkeypatch):
    vault = tmp_path / "some-vault"
    vault.mkdir()
    monkeypatch.setenv("CLAUDE_VAULT_DIR", str(vault))
    assert sources._resolve_vault_root() == vault


def test_resolve_vault_root_falls_back_when_env_unset(monkeypatch):
    monkeypatch.delenv("CLAUDE_VAULT_DIR", raising=False)
    assert sources._resolve_vault_root() == sources.HOME / "Documents" / "My_Vault"


def test_vault_present_false_when_target_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_VAULT_DIR", str(tmp_path / "does-not-exist"))
    s = _reload_sources()
    assert s.VAULT_PRESENT is False


def test_vault_present_true_when_target_exists(tmp_path, monkeypatch):
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setenv("CLAUDE_VAULT_DIR", str(vault))
    s = _reload_sources()
    assert s.VAULT_PRESENT is True


def test_generate_skips_cleanly_when_no_vault(tmp_path, monkeypatch):
    missing = tmp_path / "no-vault-here"
    monkeypatch.setenv("CLAUDE_VAULT_DIR", str(missing))
    _reload_sources()
    import generate

    importlib.reload(generate)
    rc = generate.main()
    assert rc == 0
    assert not missing.exists(), "must never mkdir the vault root into existence"


def test_generate_writes_html_when_vault_present(tmp_path, monkeypatch):
    # Deliberately not fully hermetic against the real ~/.claude — build_setup_map()
    # scans the live machine's config surface (read-only) the same way a real run
    # would. What this asserts is the vault-optional wiring: with a real directory
    # at $CLAUDE_VAULT_DIR, generate.main() writes the HTML there, full stop.
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setenv("CLAUDE_VAULT_DIR", str(vault))
    _reload_sources()
    import generate

    importlib.reload(generate)
    rc = generate.main()
    assert rc == 0
    out = vault / "Meta" / "Claude_Setup_Map.html"
    assert out.exists()
    assert "<html" in out.read_text(encoding="utf-8").lower()
