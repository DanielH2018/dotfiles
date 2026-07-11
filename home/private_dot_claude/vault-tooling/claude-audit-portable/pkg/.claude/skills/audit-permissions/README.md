# Claude Code permission-audit system (portable)

A logging-only setup that records which permissioned tool calls Claude Code makes
and which ones prompt you, so you can tune your allowlist with data instead of
guesswork. Pure Node, no dependencies, cross-platform (Windows/macOS/Linux).

## What's in here

```
.claude/
  hooks/log-permission.js          # the hook: records every in-scope tool call + prompt
  hooks/log-permission.test.js     # `node .claude/hooks/log-permission.test.js`
  scripts/audit-permissions.js     # the report: per-tool counts + segment-aware suggestions
  scripts/audit-permissions.test.js
  skills/audit-permissions/SKILL.md  # `/audit-permissions` slash command
  settings.json                    # permissions + the 3 logging hooks (portable paths)
  .gitignore                       # keeps logs/ out of git
logs/permissions.json              # created on first run (gitignored)
```

## How it works

- Three hooks (`PreToolUse`, `PermissionRequest`, `Notification`) all run
  `log-permission.js`, which appends to `.claude/logs/permissions.json`. The hook is
  `async`, swallows all errors, and uses a file lock — it never blocks or breaks a
  tool call.
- `audit-permissions.js` reads that log and reports: overall prompt rate, per-tool
  auto-approved vs. prompted counts, the most-prompted commands, **segment-aware
  suggested allowlist rules** (splits compound `a && b | c` commands, ignores
  quoted/heredoc bodies and env prefixes, cross-references your live
  `allow`/`deny`/`ask` tiers), and a **"left to prompt by design"** list of heads
  that are unsafe to blanket-allow (`rm`, `find`, `cd`, `powershell.exe`, `cat`, …).

## Install

### Empty machine (e.g. a fresh Linux server) — copy the folder

1. Copy the `.claude/` folder into your project root (the directory you run
   `claude` from).
2. Restart Claude Code so it picks up the hooks.
3. Verify: `node .claude/hooks/log-permission.test.js && node .claude/scripts/audit-permissions.test.js`

   (or just run `install.sh` from the package root — it does steps 1–3 for you.)

### Machine that already has a `.claude/settings.json` (e.g. the Mac)

`install.sh` will **not** overwrite an existing `settings.json`. It installs the
code files and drops `settings.audit-snippet.json` next to your settings. Then:

1. Merge the `permissions` and `hooks` blocks from `settings.audit-snippet.json`
   into your existing `.claude/settings.json`.
2. **Remove your previous audit system** — delete its hook command(s) from
   `settings.json` and its log/script files, so you don't double-count events.
3. Add `logs/` to `.claude/.gitignore` (if the project is a git repo).
4. Restart Claude Code.

## Daily use

Run the report any time:

```
node .claude/scripts/audit-permissions.js                 # full report
node .claude/scripts/audit-permissions.js --since 2026-06-01
node .claude/scripts/audit-permissions.js --json
node .claude/scripts/audit-permissions.js --prune 180     # drop entries older than N days
```

Or invoke the `/audit-permissions` skill, which reads the report and proposes
concrete `settings.json` allowlist edits for you to approve.

## Notes

- The log lives only on each machine (`logs/` is gitignored) — counts are per-host,
  which is what you want for per-host allowlist tuning.
- Hook paths use `$CLAUDE_PROJECT_DIR`, so the same `settings.json` works on any
  machine without editing absolute paths. Requires a recent Claude Code that sets
  that variable for hooks (all current versions do).
- `node` must be on PATH for the Claude Code process. If hooks seem inert, confirm
  `which node` resolves in the same shell Claude Code launches.
