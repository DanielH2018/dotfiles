from pathlib import Path

import pytest
from config_map import scan


def _base_paths(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    return (
        tmp_path / ".claude",
        tmp_path / "chezmoi",
        tmp_path / "work-laptop-config",
        tmp_path / "vault",
    )


def _patch_roots(monkeypatch: pytest.MonkeyPatch, claude_dir: Path, chezmoi_root: Path, work_root: Path, vault_root: Path) -> None:
    monkeypatch.setattr(scan, "CLAUDE_DIR", claude_dir)
    monkeypatch.setattr(scan, "CHEZMOI_ROOT", chezmoi_root)
    monkeypatch.setattr(scan, "WORK_CONFIG_ROOT", work_root)
    monkeypatch.setattr(scan, "VAULT_ROOT", vault_root)


def test_symlink_into_work_laptop_config_is_work(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    (work_root / ".claude" / "hooks").mkdir(parents=True)
    target = work_root / ".claude" / "hooks" / "redact-pan.sh"
    target.write_text("#!/bin/bash\n# redacts PANs\n")
    (claude_dir / "hooks").mkdir(parents=True)
    deployed = claude_dir / "hooks" / "redact-pan.sh"
    deployed.symlink_to(target)

    provenance, note = scan.provenance_for(deployed)
    assert provenance == "work"
    assert note == str(target)


def test_symlink_elsewhere_is_unmanaged(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    other_root = tmp_path / "somewhere-else"
    other_root.mkdir(parents=True)
    target = other_root / "foo.sh"
    target.write_text("body")
    (claude_dir / "hooks").mkdir(parents=True)
    deployed = claude_dir / "hooks" / "foo.sh"
    deployed.symlink_to(target)

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "unmanaged"


def test_plain_chezmoi_source_is_real(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    (chezmoi_root / "agents").mkdir(parents=True)
    (chezmoi_root / "agents" / "implementer.md").write_text("body")
    (claude_dir / "agents").mkdir(parents=True)
    deployed = claude_dir / "agents" / "implementer.md"
    deployed.write_text("body")

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "chezmoi"


def test_executable_prefix_alone_is_still_real_not_generated(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    (chezmoi_root / "hooks").mkdir(parents=True)
    (chezmoi_root / "hooks" / "executable_auto-format.sh").write_text("body")
    (claude_dir / "hooks").mkdir(parents=True)
    deployed = claude_dir / "hooks" / "auto-format.sh"
    deployed.write_text("body")

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "chezmoi"


@pytest.mark.parametrize(
    "source_name",
    ["CLAUDE.md.tmpl", "modify_settings.json.sh.tmpl", "create_foo.tmpl", "run_bar.tmpl", "symlink_baz.tmpl"],
)
def test_templating_prefixes_are_generated(tmp_path, monkeypatch, source_name):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)
    chezmoi_root.mkdir(parents=True)
    claude_dir.mkdir(parents=True)

    # Reverse-engineer the deployed name the same way chezmoi_source_for derives sources.
    if source_name.endswith(".sh.tmpl") and source_name.startswith("modify_"):
        deployed_name = source_name[len("modify_") : -len(".sh.tmpl")]
    elif source_name.endswith(".tmpl"):
        stem = source_name[: -len(".tmpl")]
        for prefix in ("create_", "run_", "symlink_"):
            if stem.startswith(prefix):
                stem = stem[len(prefix) :]
                break
        deployed_name = stem
    else:
        deployed_name = source_name

    (chezmoi_root / source_name).write_text("body")
    deployed = claude_dir / deployed_name
    deployed.write_text("body")

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "generated"


def test_no_chezmoi_source_and_not_a_symlink_is_unmanaged(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    chezmoi_root.mkdir(parents=True)
    (claude_dir / "hooks").mkdir(parents=True)
    deployed = claude_dir / "hooks" / "mystery.sh"
    deployed.write_text("body")

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "unmanaged"


def test_project_file_under_vault_root_is_project(tmp_path, monkeypatch):
    claude_dir, chezmoi_root, work_root, vault_root = _base_paths(tmp_path)
    _patch_roots(monkeypatch, claude_dir, chezmoi_root, work_root, vault_root)

    vault_root.mkdir(parents=True)
    deployed = vault_root / "CLAUDE.md"
    deployed.write_text("body")

    provenance, _ = scan.provenance_for(deployed)
    assert provenance == "project"
