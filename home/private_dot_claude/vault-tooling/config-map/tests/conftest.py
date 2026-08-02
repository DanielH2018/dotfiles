import json
import plistlib
from pathlib import Path

import pytest
from config_map import provenance, scan


def patch_roots(monkeypatch: pytest.MonkeyPatch, **roots: Path) -> None:
    """Point the root constants at a temp tree.

    Both modules bind these by name from .sources, and which module holds which
    is an implementation detail that has already moved once. Setting each one
    wherever it exists means a constant that changes sides stays patched, and a
    name that exists in neither still fails loudly.
    """
    for name, value in roots.items():
        found = [m for m in (scan, provenance) if hasattr(m, name)]
        assert found, f"no module defines {name}"
        for module in found:
            monkeypatch.setattr(module, name, value)


@pytest.fixture
def fake_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """A hermetic ~/.claude + chezmoi + work-laptop-config + vault tree.

    Isolated from the real machine so determinism/no-secrets tests don't depend
    on whatever happens to be on disk when the suite runs.
    """
    home = tmp_path / "home"
    claude_dir = home / ".claude"
    chezmoi_root = tmp_path / "chezmoi"
    work_root = home / "work-laptop-config"
    vault_root = tmp_path / "vault"

    for sub in (
        "hooks",
        "agents",
        "commands",
        "rules",
        "output-styles",
        "scheduled",
        "plugins",
        "docs",
    ):
        (claude_dir / sub).mkdir(parents=True)
    (claude_dir / "skills" / "demo-skill").mkdir(parents=True)
    (chezmoi_root / "hooks").mkdir(parents=True)
    (work_root / ".claude" / "hooks").mkdir(parents=True)
    vault_root.mkdir(parents=True)

    (chezmoi_root / "hooks" / "executable_demo-hook.sh").write_text(
        "#!/bin/bash\n# demo hook purpose\n"
    )
    (claude_dir / "hooks" / "demo-hook.sh").write_text(
        "#!/bin/bash\n# demo hook purpose\n"
    )

    work_hook = work_root / ".claude" / "hooks" / "work-hook.sh"
    work_hook.write_text("#!/bin/bash\n# work hook purpose\n")
    (claude_dir / "hooks" / "work-hook.sh").symlink_to(work_hook)

    settings = {
        "permissions": {"allow": ["a", "b"], "deny": ["c"], "ask": []},
        "skillOverrides": {"demo": "off"},
        "sandbox": {
            "enabled": True,
            "network": {"allowedDomains": ["x"]},
            "filesystem": {"allowWrite": ["y"], "denyRead": []},
        },
        "env": {"EDITOR": "vim"},
        "outputStyle": "Terse",
        "effortLevel": "high",
        "enabledPlugins": {
            "demo-plugin@demo-market": True,
            "off-plugin@demo-market": False,
        },
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash",
                    "hooks": [
                        {
                            "type": "command",
                            "command": "~/.claude/hooks/demo-hook.sh",
                            "timeout": 10,
                        }
                    ],
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "Edit",
                    "hooks": [
                        {"type": "command", "command": "~/.claude/hooks/work-hook.sh"}
                    ],
                }
            ],
        },
    }
    (claude_dir / "settings.json").write_text(json.dumps(settings))

    (claude_dir / "agents" / "demo-agent.md").write_text(
        '---\ndescription: "demo agent purpose"\n---\nbody'
    )
    (claude_dir / "commands" / "demo-cmd.md").write_text(
        '---\ndescription: "demo command purpose"\n---\nbody'
    )
    (claude_dir / "rules" / "demo-rule.md").write_text("- a rule, no frontmatter")
    (claude_dir / "output-styles" / "demo-style.md").write_text(
        '---\ndescription: "demo style purpose"\n---\nbody'
    )
    (claude_dir / "skills" / "demo-skill" / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: demo skill purpose\n---\nbody"
    )

    plugin_install = claude_dir / "plugins" / "cache" / "demo-plugin"
    (plugin_install / ".claude-plugin").mkdir(parents=True)
    (plugin_install / ".claude-plugin" / "plugin.json").write_text(
        json.dumps(
            {"name": "demo-plugin", "description": "demo plugin does useful things"}
        )
    )
    (claude_dir / "plugins" / "installed_plugins.json").write_text(
        json.dumps(
            {
                "plugins": {
                    "demo-plugin@demo-market": [
                        {
                            "scope": "user",
                            "version": "1.0.0",
                            "installPath": str(plugin_install),
                        }
                    ],
                    "off-plugin@demo-market": [{"scope": "user", "version": "2.0.0"}],
                }
            }
        )
    )
    (claude_dir / "plugins" / "known_marketplaces.json").write_text(
        json.dumps({"demo-market": {}})
    )

    (claude_dir / "CLAUDE.md").write_text(
        "# Main\n\n## Section A\n\ntext\n\n## Section B\n\n@~/.claude/docs/extra.md\n"
    )
    (claude_dir / "docs" / "extra.md").write_text("extra doc body")

    (vault_root / "CLAUDE.md").write_text("project claude md, no includes\n")

    plist = {
        "Label": "com.demo.claude.task",
        "ProgramArguments": [
            "/bin/zsh",
            "-lc",
            "exec ~/.claude/scheduled/run-skill.sh healthcheck headless",
        ],
        "StartCalendarInterval": [
            {"Weekday": w, "Hour": 8, "Minute": 15} for w in range(1, 6)
        ],
    }
    with (claude_dir / "scheduled" / "com.demo.claude.task.plist").open("wb") as fh:
        plistlib.dump(plist, fh)

    claude_json = tmp_path / "claude.json"
    claude_json.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "grafana": {"command": "grafana-mcp", "token": "sk-should-not-leak"}
                }
            }
        )
    )

    mcp_cache = claude_dir / "mcp-needs-auth-cache.json"
    mcp_cache.write_text(
        json.dumps({"claude.ai Demo Connector": {"id": "mcpsrv_secretvalue"}})
    )

    patch_roots(
        monkeypatch,
        HOME=home,
        CLAUDE_DIR=claude_dir,
        CHEZMOI_ROOT=chezmoi_root,
        WORK_CONFIG_ROOT=work_root,
        VAULT_ROOT=vault_root,
        CLAUDE_JSON=claude_json,
        MCP_NEEDS_AUTH_CACHE=mcp_cache,
        MANAGED_SETTINGS=tmp_path / "absent-managed-settings.json",
        PROJECT_SETTINGS_LOCAL=vault_root / ".claude" / "settings.local.json",
        PROJECT_SETTINGS=vault_root / ".claude" / "settings.json",
        PROJECT_CLAUDE_MD=vault_root / "CLAUDE.md",
    )

    return {
        "home": home,
        "claude_dir": claude_dir,
        "chezmoi_root": chezmoi_root,
        "work_root": work_root,
        "vault_root": vault_root,
    }
