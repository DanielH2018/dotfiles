---
name: config-lint
description: Use to audit a Claude Code config dir for drift — dead/dormant plugins, orphaned hook script paths, absent @-includes, duplicate skill names, CLAUDE.md bloat — and to advise whether each instruction lives in the right home (hook vs skill vs rule vs permission). Report-only. Triggers on "audit my claude config", "config drift", "lint my setup", "check my CLAUDE.md".
---

# config-lint

Two passes: a deterministic drift scan (a script — trust its output), then an
advisory placement review (judgment — clearly labelled as suggestions). This
skill is **report-only**: it never edits config. Present findings and proposed
fixes for approval.

## 1 — Deterministic drift scan

Run the script and report its output verbatim, then explain each finding:

```
node ~/.claude/skills/config-lint/scripts/config-lint.js
```

- Add a path argument to audit a project's config instead of `~/.claude`, e.g.
  `node ~/.claude/skills/config-lint/scripts/config-lint.js "$PWD/.claude"`.
- `--strict` exits non-zero when there are SHOULD-FIX findings (for CI/hooks).
- `--json` for machine-readable output.

What it checks: `enabledPlugins` vs `installed_plugins.json` (dead = enabled but
not installed; dormant = installed but not enabled), hook `command` script paths
that don't exist, `@`-include targets absent on disk, skill-name collisions
across user + plugin skills, and CLAUDE.md size vs a soft bloat cap.

## 2 — Advisory placement review (judgment)

Read the active CLAUDE.md chain (global `~/.claude/CLAUDE.md`, any project
`CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/rules/*`). For each durable
instruction, sanity-check whether it's in the right home, using this mapping:

- "**always** run X" / deterministic pre/post action → a **hook**
- "**never** do Y" / a hard prohibition → a **hook** or a **permission** deny rule
- a long multi-step **procedure** → a **skill**
- a rule that only applies **under a path** → a path-scoped file in `rules/`
- a **personal preference** sitting in a shared/project file → move to **user-level**

Only flag **clear** mismatches, and present them as *suggestions*, not defects —
prose classification is unreliable, so stay conservative and skip anything
borderline. The deterministic scan in pass 1 is the authoritative part.

## 3 — Reporting

List drift findings (from the script) and placement suggestions (from pass 2)
separately. Propose a concrete fix for each but **do not apply anything**. For
global `~/.claude` config, remember fixes edit the chezmoi **source** then
`chezmoi apply` — never the deployed copy (run `chezmoi source-path <file>`
first). Confirm before changing anything.
