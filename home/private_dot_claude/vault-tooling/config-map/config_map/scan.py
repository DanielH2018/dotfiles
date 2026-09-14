"""Filesystem scan + provenance detection (SPEC.md §4)."""

from __future__ import annotations

import plistlib
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from xml.parsers.expat import ExpatError

from .model import CascadeNode, Category, Item, Layer, SetupMap
from .provenance import (
    humanize_filename,
    is_relative_to,
    leading_comment,
    provenance_for,
    purpose_for,
    read_json,
)
from .sources import (
    CLAUDE_DIR,
    CLAUDE_JSON,
    HOME,
    MANAGED_SETTINGS,
    MCP_NEEDS_AUTH_CACHE,
    PROJECT_CLAUDE_MD,
    PROJECT_SETTINGS,
    PROJECT_SETTINGS_LOCAL,
    WORK_CONFIG_ROOT,
)

HOOK_CMD_RE = re.compile(r"~/\.claude/hooks/([\w.\-]+)")
INCLUDE_RE = re.compile(r"^@(\S+)\s*$", re.MULTILINE)
HEADING_RE = re.compile(r"^(#{1,2})\s+(.+?)\s*$", re.MULTILINE)
RUN_SKILL_RE = re.compile(r"run-skill\.sh\s+(\S+)\s+(\S+)")
WEEKDAY_NAMES = {
    0: "Sun",
    1: "Mon",
    2: "Tue",
    3: "Wed",
    4: "Thu",
    5: "Fri",
    6: "Sat",
    7: "Sun",
}


def _resolve_include(token: str, base_dir: Path) -> Path:
    if token.startswith("~"):
        return Path(token).expanduser()
    candidate = Path(token)
    return candidate if candidate.is_absolute() else (base_dir / candidate).resolve()


def _display_label(path: Path) -> str:
    if is_relative_to(path, HOME):
        return f"~/{path.relative_to(HOME)}"
    return str(path)


def _section_headings(text: str) -> tuple[tuple[int, str], ...]:
    return tuple(
        (len(m.group(1)), m.group(2).strip()) for m in HEADING_RE.finditer(text)
    )


def _cascade_node(
    path: Path, seen: frozenset[Path] = frozenset()
) -> CascadeNode | None:
    if path in seen or len(seen) > 20 or not path.exists():
        return None
    provenance, _ = provenance_for(path)
    text = path.read_text(encoding="utf-8", errors="replace")
    children = []
    for match in INCLUDE_RE.finditer(text):
        child_path = _resolve_include(match.group(1), path.parent)
        child = _cascade_node(child_path, seen | {path})
        if child is not None:
            children.append(child)
    return CascadeNode(
        label=_display_label(path),
        provenance=provenance,
        children=tuple(children),
        headings=_section_headings(text),
        line_count=len(text.splitlines()),
    )


def scan_claude_md_cascade() -> tuple[CascadeNode, ...]:
    roots = [_cascade_node(CLAUDE_DIR / "CLAUDE.md"), _cascade_node(PROJECT_CLAUDE_MD)]
    return tuple(node for node in roots if node is not None)


def _layer_from_settings(name: str, path: Path) -> Layer:
    data = read_json(path)
    if data is None:
        return Layer(name=name, path=str(path), present=False)
    perms = data.get("permissions", {}) or {}
    fields: list[tuple[str, str]] = [
        ("allow", str(len(perms.get("allow", []) or []))),
        ("deny", str(len(perms.get("deny", []) or []))),
        ("ask", str(len(perms.get("ask", []) or []))),
    ]
    skill_overrides = data.get("skillOverrides") or {}
    if skill_overrides:
        fields.append(
            (
                "skillOverrides",
                ", ".join(f"{k}={v}" for k, v in sorted(skill_overrides.items())),
            )
        )
    sandbox = data.get("sandbox")
    if sandbox:
        net = sandbox.get("network", {}) or {}
        fs = sandbox.get("filesystem", {}) or {}
        fields.append(
            (
                "sandbox",
                f"enabled={sandbox.get('enabled', False)}; "
                f"{len(net.get('allowedDomains', []))} allowed domains; "
                f"{len(fs.get('allowWrite', []))} write paths; "
                f"{len(fs.get('denyRead', []))} deny-read paths",
            )
        )
    env = data.get("env") or {}
    if env:
        fields.append(("env", ", ".join(sorted(env.keys()))))
    for key in ("outputStyle", "effortLevel", "advisorModel"):
        if key in data:
            fields.append((key, str(data[key])))
    if "fallbackModel" in data:
        fields.append(("fallbackModel", ", ".join(data["fallbackModel"])))
    if "availableModels" in data:
        fields.append(("availableModels", ", ".join(data["availableModels"])))
    return Layer(name=name, path=str(path), present=True, fields=tuple(fields))


def scan_settings_layers() -> tuple[Layer, ...]:
    # Highest to lowest precedence — confirmed against code.claude.com/docs/en/settings.md
    # ("Settings Priority Order (Highest to Lowest)"), 2026-07-10.
    return (
        _layer_from_settings("managed", MANAGED_SETTINGS),
        _layer_from_settings("project-local", PROJECT_SETTINGS_LOCAL),
        _layer_from_settings("project", PROJECT_SETTINGS),
        _layer_from_settings("user", CLAUDE_DIR / "settings.json"),
    )


def scan_hooks() -> Category:
    data = read_json(CLAUDE_DIR / "settings.json") or {}
    hooks_cfg = data.get("hooks", {}) or {}
    items = []
    for event in sorted(hooks_cfg):
        for entry in hooks_cfg[event]:
            matcher = entry.get("matcher")
            for hook in entry.get("hooks", []):
                command = hook.get("command", "")
                match = HOOK_CMD_RE.search(command)
                if match:
                    script_name = match.group(1)
                    script_path = CLAUDE_DIR / "hooks" / script_name
                    provenance, _ = provenance_for(script_path)
                    purpose = leading_comment(script_path) or script_name
                    label = script_name
                else:
                    provenance = "inline"
                    purpose = command if len(command) <= 70 else command[:67] + "..."
                    label = command.split()[0] if command else "(empty)"
                fields = [("event", event)]
                if matcher:
                    fields.append(("matcher", matcher))
                if hook.get("timeout") is not None:
                    fields.append(("timeout", str(hook["timeout"])))
                items.append(
                    Item(
                        name=f"{event}: {label}",
                        purpose=purpose,
                        provenance=provenance,
                        fields=tuple(fields),
                    )
                )
    return Category(
        key="hooks", title="Hooks", items=tuple(items), note=f"{len(hooks_cfg)} events"
    )


def _scan_flat_md_category(dirname: str, key: str, title: str) -> Category:
    deployed_dir = CLAUDE_DIR / dirname
    items = []
    if deployed_dir.is_dir():
        for path in sorted(deployed_dir.glob("*.md")):
            provenance, _ = provenance_for(path)
            items.append(
                Item(name=path.stem, purpose=purpose_for(path), provenance=provenance)
            )
    return Category(key=key, title=title, items=tuple(items))


def scan_commands() -> Category:
    return _scan_flat_md_category("commands", "commands", "Commands")


def scan_agents() -> Category:
    return _scan_flat_md_category("agents", "agents", "Agents")


def scan_output_styles() -> Category:
    return _scan_flat_md_category("output-styles", "output-styles", "Output styles")


def scan_rules() -> Category:
    deployed_dir = CLAUDE_DIR / "rules"
    items = []
    if deployed_dir.is_dir():
        for path in sorted(deployed_dir.glob("*.md")):
            provenance, _ = provenance_for(path)
            items.append(
                Item(
                    name=path.stem,
                    purpose=humanize_filename(path),
                    provenance=provenance,
                )
            )
    return Category(key="rules", title="Rules", items=tuple(items))


def scan_skills() -> Category:
    deployed_dir = CLAUDE_DIR / "skills"
    items = []
    if deployed_dir.is_dir():
        for skill_dir in sorted(p for p in deployed_dir.iterdir() if p.is_dir()):
            skill_md = skill_dir / "SKILL.md"
            if not skill_md.exists():
                continue
            provenance, _ = provenance_for(skill_md)
            items.append(
                Item(
                    name=skill_dir.name,
                    purpose=purpose_for(skill_md),
                    provenance=provenance,
                )
            )
    return Category(key="skills", title="Skills", items=tuple(items))


def _plugin_description(record: dict) -> str | None:
    install_path = record.get("installPath")
    if not install_path:
        return None
    manifest = read_json(Path(install_path) / ".claude-plugin" / "plugin.json")
    if manifest and manifest.get("description"):
        return str(manifest["description"]).strip()
    return None


def scan_plugins() -> Category:
    installed = read_json(CLAUDE_DIR / "plugins/installed_plugins.json") or {}
    enabled_map = (read_json(CLAUDE_DIR / "settings.json") or {}).get(
        "enabledPlugins", {}
    ) or {}
    plugins = installed.get("plugins", {}) or {}
    marketplaces = read_json(CLAUDE_DIR / "plugins/known_marketplaces.json") or {}
    items = []
    hidden = 0
    for key in sorted(plugins):
        # A plugin is active only when settings.json marks it explicitly enabled;
        # both enabled=false and unlisted plugins are inactive and are hidden.
        if enabled_map.get(key) is not True:
            hidden += 1
            continue
        records = plugins[key]
        record = records[0] if records else {}
        name, _, marketplace = key.rpartition("@")
        description = (
            _plugin_description(record) or f"plugin in {marketplace or 'unknown'}"
        )
        fields = (
            ("marketplace", marketplace or "unknown"),
            ("scope", record.get("scope", "unknown")),
            ("version", record.get("version", "unknown")),
        )
        items.append(
            Item(name=name or key, purpose=description, provenance="", fields=fields)
        )
    note = f"{len(items)} enabled plugins across {len(marketplaces)} marketplaces: {', '.join(sorted(marketplaces))}"
    if hidden:
        note += f"; {hidden} disabled/unlisted hidden"
    return Category(key="plugins", title="Plugins", items=tuple(items), note=note)


def _collect_mcp_server_keys(obj: object) -> set[str]:
    """Recursively pull mcpServers dict *keys* out of a parsed JSON tree — never values."""
    keys: set[str] = set()
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "mcpServers" and isinstance(value, dict):
                keys.update(value.keys())
            else:
                keys.update(_collect_mcp_server_keys(value))
    elif isinstance(obj, list):
        for entry in obj:
            keys.update(_collect_mcp_server_keys(entry))
    return keys


def scan_mcp() -> Category:
    claude_json = read_json(CLAUDE_JSON) or {}
    local_keys = sorted(_collect_mcp_server_keys(claude_json))
    # Count the needs-auth connectors to report how many are hidden, but never
    # render their names or ids — the cache holds server ids we treat as secret.
    needs_auth_count = len(read_json(MCP_NEEDS_AUTH_CACHE) or {})
    items = tuple(
        Item(
            name=name,
            purpose="local MCP server (~/.claude.json)",
            provenance="",
            fields=(("kind", "local"),),
        )
        for name in local_keys
    )
    note = "Only active servers shown."
    if needs_auth_count:
        note += f" {needs_auth_count} claude.ai connector(s) needing auth are hidden."
    note += (
        " Connected claude.ai connectors have no local manifest this scan can read deterministically "
        "(see SPEC.md §12)."
    )
    return Category(key="mcp", title="MCP servers", items=items, note=note)


def _summarize_schedule(intervals: object) -> str:
    if not intervals:
        return "unknown"
    if isinstance(intervals, dict):
        intervals = [intervals]
    groups: dict[tuple[int, int], list[int]] = {}
    for entry in intervals:
        hour = entry.get("Hour", 0)
        minute = entry.get("Minute", 0)
        groups.setdefault((hour, minute), []).append(entry.get("Weekday"))
    parts = []
    for (hour, minute), weekdays in sorted(groups.items()):
        days = sorted(w for w in weekdays if w is not None)
        if days == [1, 2, 3, 4, 5]:
            day_label = "weekdays"
        elif days:
            day_label = ",".join(WEEKDAY_NAMES.get(w, str(w)) for w in days)
        else:
            day_label = "daily"
        parts.append(f"{day_label} {hour:02d}:{minute:02d}")
    return "; ".join(parts)


def scan_scheduled() -> Category:
    deployed_dir = CLAUDE_DIR / "scheduled"
    items = []
    if deployed_dir.is_dir():
        for path in sorted(deployed_dir.glob("*.plist")):
            provenance, _ = provenance_for(path)
            try:
                with path.open("rb") as fh:
                    plist = plistlib.load(fh)
            # ExpatError is neither OSError nor ValueError, so malformed XML used
            # to escape this guard and abort the whole scan. This map is a report
            # about the machine: one unreadable file costs that entry, never the
            # report.
            except (OSError, ValueError, ExpatError, plistlib.InvalidFileException):
                continue
            joined = " ".join(plist.get("ProgramArguments", []))
            match = RUN_SKILL_RE.search(joined)
            skill = match.group(1) if match else "unknown"
            mode = match.group(2) if match else "unknown"
            schedule = _summarize_schedule(plist.get("StartCalendarInterval"))
            fields = (("schedule", schedule), ("skill", skill), ("mode", mode))
            items.append(
                Item(
                    name=path.stem,
                    purpose=f"runs /{skill} ({mode})",
                    provenance=provenance,
                    fields=fields,
                )
            )
    return Category(key="scheduled", title="Scheduled tasks", items=tuple(items))


def git_short_sha(repo: Path) -> str | None:
    if not (repo / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=repo,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except OSError:
        return None
    return result.stdout.strip() or None if result.returncode == 0 else None


def build_setup_map() -> SetupMap:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    source_shas = (
        ("chezmoi", git_short_sha(HOME / ".local/share/chezmoi") or "unknown"),
        ("work-laptop-config", git_short_sha(WORK_CONFIG_ROOT) or "unknown"),
    )
    categories = (
        scan_hooks(),
        scan_skills(),
        scan_commands(),
        scan_agents(),
        scan_rules(),
        scan_output_styles(),
        scan_plugins(),
        scan_mcp(),
        scan_scheduled(),
    )
    counts = tuple((c.title, str(len(c.items))) for c in categories)
    return SetupMap(
        generated_at=generated_at,
        source_shas=source_shas,
        layers=scan_settings_layers(),
        cascade=scan_claude_md_cascade(),
        categories=categories,
        counts=counts,
    )
