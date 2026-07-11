"""Path constants for the config-map inputs (see SPEC.md §4)."""

from __future__ import annotations

import os
from pathlib import Path

HOME = Path.home()

CLAUDE_DIR = HOME / ".claude"
CHEZMOI_ROOT = HOME / ".local/share/chezmoi/home/private_dot_claude"
WORK_CONFIG_ROOT = HOME / "work-laptop-config"
WORK_CLAUDE_DIR = WORK_CONFIG_ROOT / ".claude"
MANAGED_SETTINGS = Path("/Library/Application Support/ClaudeCode/managed-settings.json")

# Not read directly here (see SPEC.md §8) — scan.py reads it and extracts only
# mcpServers keys, never values. Kept as a constant so the literal path lives
# in exactly one place, away from any Bash command string.
CLAUDE_JSON = HOME / ".claude.json"

MCP_NEEDS_AUTH_CACHE = CLAUDE_DIR / "mcp-needs-auth-cache.json"


def _resolve_vault_root() -> Path:
    """Resolve the vault location from $CLAUDE_VAULT_DIR, falling back to the
    documented default. This tool no longer lives inside the vault (its canonical
    home is the dotfiles/chezmoi checkout), so it can't infer the vault root by
    walking up from its own install path — env is the only thing that works on
    every machine this deploys to, vault or no vault. See VAULT_PRESENT below for
    the "no vault configured" case — callers must check that, not assume this
    path exists."""
    env = os.environ.get("CLAUDE_VAULT_DIR")
    if env:
        return Path(env).expanduser()
    return HOME / "Documents" / "My_Vault"


VAULT_ROOT = _resolve_vault_root()
# Vault-optional contract: callers (generate.py) must check this before writing
# anything under VAULT_ROOT — never mkdir/write a vault section into existence.
VAULT_PRESENT = VAULT_ROOT.is_dir()

PROJECT_SETTINGS_LOCAL = VAULT_ROOT / ".claude/settings.local.json"
PROJECT_SETTINGS = VAULT_ROOT / ".claude/settings.json"
PROJECT_CLAUDE_MD = VAULT_ROOT / "CLAUDE.md"

OUTPUT_HTML = VAULT_ROOT / "Meta/Claude_Setup_Map.html"
OUTPUT_HASH = Path(__file__).resolve().parents[1] / ".semantic_hash"

# Templating prefixes that mark a chezmoi source as generating its deployed
# file rather than deploying it verbatim (SPEC.md §4 provenance rule #2).
CHEZMOI_TEMPLATING_PREFIXES = ("modify_", "create_", "run_", "run_once_", "symlink_")
CHEZMOI_TEMPLATING_SUFFIX = ".tmpl"

# Runtime/state dirs excluded from the scan (SPEC.md §2 non-goals).
RUNTIME_DIR_NAMES = frozenset(
    {
        "sessions",
        "file-history",
        "session-env",
        "cache",
        "logs",
        "backups",
        "projects",
        "shell-snapshots",
        "downloads",
        "ide",
        "daemon",
        "tasks",
        "workflows",
        "plans",
        "paste-cache",
        "scripts",
        "artifacts",
    }
)
