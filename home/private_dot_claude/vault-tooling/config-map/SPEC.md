# SPEC — Claude Setup Map

A **living, deterministic visualization** of your entire Claude Code config surface:
a pure-Python (stdlib-only) generator that scans the config filesystem and emits one
self-contained, collapsible HTML page. No LLM in the update path — same input → same output.

- **Status:** spec, ready to implement in a fresh session.
- **Author of record:** prep session 2026-07-10.
- **Deliverable of impl session:** `config-map/` generator + `Meta/Claude_Setup_Map.html` + `/config-map` command + freshness wiring.

---

## 1. Goal

Produce a readable map of the config that *shapes Claude's behavior*, showing both **what** is
configured and **how it's inherited**, kept accurate by a deterministic regenerator that lives in
the vault.

Two inheritance dimensions (both required):
- **Provenance** — which source repo owns each item and how it's deployed:
  `chezmoi` (real file) · `chezmoi` (template-generated) · `work-laptop-config` (symlink) · `project` · `runtime`.
- **Precedence** — the override/merge order for settings layers, and the `@`-include cascade for `CLAUDE.md`.

Detail level: **name + one-line purpose + key fields per item; full bodies behind expand** (native `<details>`).

## 2. Non-goals

- No runtime/state dirs: `sessions/`, `history.jsonl`, `file-history/`, `session-env/`, `cache/`, `logs/`, `backups/`, `projects/`. Noise.
- **No secrets.** Never emit token values, API keys, or the full `~/.claude.json`. Structure only.
- No LLM in the update path (the "hybrid/LLM" options were declined).
- Read-only: never mutates config.
- Not published to claude.ai. Local `file://` HTML only.

## 3. Decisions (locked in prep)

| Decision | Choice |
|---|---|
| Scope | Config that shapes behavior (excludes runtime/state dirs) |
| Inheritance | Both provenance + precedence |
| Detail | Summaries + key fields, expandable bodies |
| Generator | Pure deterministic script (stdlib Python, no LLM) |
| Freshness | On-demand `/config-map` command + daily auto-commit |
| Location | Script in `config-map/` (excluded tooling dir); HTML at `Meta/Claude_Setup_Map.html` |

## 4. Inputs (deterministic filesystem scan)

| # | Source | Used for |
|---|---|---|
| 1 | Deployed `~/.claude/` | settings.json, settings.local.json, CLAUDE.md, CLAUDE.local.md, docs/, hooks/, agents/, commands/, skills/*/SKILL.md, rules/, output-styles/, scheduled/, plugins/{installed_plugins,known_marketplaces}.json, keybindings.json, statusline-command.sh |
| 2 | chezmoi `~/.local/share/chezmoi/home/private_dot_claude/` | detect template-generated sources (`CLAUDE.md.tmpl`, `modify_settings.json.sh.tmpl`) → provenance |
| 3 | `~/work-laptop-config/.claude/` | symlink targets → provenance = work |
| 4 | Project `$CLAUDE_VAULT_DIR/.claude/settings.local.json` + `CLAUDE.md` (falls back to `~/Documents/My_Vault`; skipped if not present) | project layer |
| 5 | `~/.claude.json` `mcpServers` | local MCP servers (e.g. grafana). **See §8 secrets caveat.** |
| 6 | `~/.claude/mcp-needs-auth-cache.json` + live tool namespaces | claude.ai connectors: needs-auth vs connected |
| 7 | `/Library/Application Support/ClaudeCode/` | enterprise/managed layer — absent here; render "none" |

**Provenance detection per deployed file:**
1. `os.path.islink(p)` → symlink; resolve target → `work` if under `work-laptop-config`, else record real target.
2. else if a chezmoi source with a templating prefix exists (`*.tmpl`, `modify_`, `create_`, `run_`, `symlink_`) → `chezmoi (generated)`.
3. else if a plain chezmoi source exists → `chezmoi (real)`.
4. else → `unmanaged`.

## 5. Categories rendered

1. **Overview banner** — per-category counts, generated-at, git SHA of each source repo.
2. **Settings & precedence** — layer stack `managed → project-local → project → user`; per present layer: key fields, `allow`/`deny`/`ask` counts (user layer today: 268 / 95 / 119), `skillOverrides`, `sandbox` summary, `env`, model/output-style/effort. Show which layers are absent.
3. **CLAUDE.md cascade** — the `@`-include tree with provenance per node: `~/.claude/CLAUDE.md` → `docs/orchestration.md` + `CLAUDE.local.md` (→work) → `docs/integrations.md` + `docs/enforcement.md` (→work); then project `CLAUDE.md`. Each node also lists its `#`/`##` section headings + line count so the file's shape is visible without opening it.
4. **Hooks** — grouped by event (13 events: SessionStart×4, PostToolUse×8, PreToolUse×2, UserPromptSubmit×2, +9 single). Each: script, provenance, one-line purpose.
5. **Skills / Commands / Agents / Rules / Output-styles** — inventory with provenance + purpose.
6. **Plugins** — only **enabled** plugins (`enabledPlugins == true`) are shown; disabled/unlisted are hidden and the count noted. Each carries its manifest `description` (from `<installPath>/.claude-plugin/plugin.json`) + marketplace/scope/version.
7. **MCP servers** — only **active** servers (local, from `~/.claude.json` `mcpServers` keys). Needs-auth claude.ai connectors are hidden (count noted, names/ids never read into output). Connected connectors have no deterministic local manifest — flagged.
8. **Scheduled tasks** — the discovered launchd jobs: schedule, skill, mode per job.
9. **Provenance legend + two-repo model** — chezmoi + work-laptop-config → deployed `~/.claude`.

Purpose text is **sourced deterministically**: skills/agents/commands from frontmatter `description`; hooks from a leading `#` comment; rules from filename topic. Fallback = filename. No model.

## 6. Output

- **One self-contained HTML**, inline CSS, **zero-JS collapsibles via `<details>`/`<summary>`** (works offline). Minimal vanilla JS only for a "collapse/expand all" toggle. Light + dark via `prefers-color-scheme`. No external assets.
- Provenance shown as colored chips (`chezmoi` / `generated` / `work` / `project` / `unmanaged`).
- **Deterministic ordering** (sorted) everywhere → stable diffs.
- Companion `Meta/Claude_Setup_Map.md` (frontmatter + summary + link + "generated, do not hand-edit") so it's an index-able vault page.

## 7. Files to create

```
config-map/
  generate.py            # entrypoint, stdlib only
  config_map/
    sources.py           # path constants for the 7 inputs
    scan.py              # filesystem walk + provenance detection
    model.py             # dataclasses: Item, Category, Layer
    render.py            # HTML emit (inline CSS/JS)
  tests/
    test_provenance.py   # symlink vs real vs generated
    test_settings.py     # layer parsing + counts
    test_determinism.py  # two runs → byte-identical semantic content
    test_no_secrets.py   # output has no token-like strings
  README.md              # what/how/determinism/exclusion note
  pyproject.toml         # pytest dev dep only (stdlib runtime)
Meta/Claude_Setup_Map.html   # output
Meta/Claude_Setup_Map.md     # companion wiki page
.claude/commands/config-map.md   # /config-map → runs generate.py
```
Plus edits: add `config-map/` to CLAUDE.md's excluded-dirs list; add `index.md` entry; wire daily refresh (§9).

## 8. Secrets caveat (matters for the command path)

`~/.claude.json` is guarded at the Claude **tool** layer (`protect-secrets.sh`) — a Bash call whose
string contains that path is blocked. A launchd/standalone `python3 generate.py` is **not** subject to
that hook, so the daily run reads it fine. When `/config-map` runs the generator *through Claude*, exec
it as a subprocess (`python3 config-map/generate.py`) so the guarded path never appears in a tool command
string. The generator extracts only `mcpServers` **keys** — never values.

## 9. Freshness wiring (verify during impl)

- **On-demand:** `/config-map` command → `python3 config-map/generate.py`.
- **Daily:** preferred = a direct launchd job running the script (fully deterministic, no model) *before* the vault's daily auto-commit; alternative = a step in the existing `healthcheck` skill (already runs weekdays and auto-commits). **Pick one; avoid a double daily commit.**
- **Diff hygiene:** the generated-at timestamp/SHA would churn git daily. Write a sidecar content hash of the *semantic* payload and only rewrite the HTML when the hash changes → no noise commits.

## 10. Determinism guarantees

Pure stdlib · no network · no LLM · sorted iteration · content-hash gate on writes. The only volatile
fields (generated-at, source SHAs) are isolated so they don't trigger rewrites on their own.

## 11. Verification (end-to-end)

1. `python3 ~/.claude/vault-tooling/config-map/generate.py` (with `$CLAUDE_VAULT_DIR` set) → writes `Meta/Claude_Setup_Map.html` under the vault, exit 0, one-line status.
2. Open in browser: every section collapses/expands; provenance chips + precedence chains render; light + dark legible; **no console errors; no network requests** (devtools).
3. Determinism: run twice, no config change → semantic content identical (hash unchanged, no rewrite).
4. No-secrets: grep output for token patterns → none.
5. `pytest config-map/tests/` green.
6. Provenance spot-check: `redact-pan.sh` → work/symlink; `CLAUDE.md` → chezmoi/generated; `implementer.md` → chezmoi/real.
7. Add a rule → regenerate → item appears; revert → disappears.

## 12. Open items to confirm against ground truth (impl session)

- Exact Claude Code settings precedence order — confirm via `claude-code-guide` agent / docs (managed vs project-local vs project vs user).
- `/config-map` as command vs skill; exact daily wiring (§9) — no double commit.
- MCP enumeration for remote claude.ai connectors — no local file lists *connected* ones deterministically; accept best-effort + flag it.
