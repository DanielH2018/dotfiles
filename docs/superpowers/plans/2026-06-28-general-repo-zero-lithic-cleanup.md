# General-repo zero-Lithic cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Lithic/work-specific reference from the work-agnostic general dotfiles repo (`~/.local/share/chezmoi`), relocating the behaviour those references provided onto the work laptop via the existing extension-point pattern.

**Architecture:** Parameterize the vault path in the shared Claude hooks behind an optional, work-repo-owned `~/.config/claude/local.env` (`CLAUDE_VAULT_DIR`); move the wholly-vault `capture-session` command to the work repo; scrub Lithic-specific wording to generic (keeping PCI/SOC2); split the sandbox `settings.json` and the two PagerDuty read perms in the main settings base into base + work overlay, merged at launch/render time.

**Tech Stack:** bash (hooks, `claude-sandbox`), Node.js (`node:assert` tests, `claude-settings-merge`), chezmoi, JSON settings, the work repo `~/work-laptop-config` (a symlink farm), `dotsync`.

## Global Constraints

- **Scrub Lithic-specific wording only; KEEP industry-standard PCI-DSS / SOC2 references** verbatim. Targets to remove: the literal vendor names `Lithic`, `Grafana`, `PagerDuty`, the phrase `card-issuing`, and `My_Vault` paths.
- **Acceptance gate:** `grep -rniE 'lithic|grafana|pagerduty|card.issu|my_vault' ~/.local/share/chezmoi/home/ --include='*' | grep -v '/docs/'` returns **nothing**, and `dotsync check` prints `check: clean`.
- **Hooks and `claude-sandbox` MUST behave correctly when `CLAUDE_VAULT_DIR` is unset** (generic, vault-unaware): never depend on the work overlay or `local.env` existing. The overlay/`local.env` are optional and **work-repo-owned**; the general repo never contains them.
- **The sandbox must launch both with and without the work overlay.** The overlay-absent code path must be equivalent to today's behaviour minus the moved work-MCP denies.
- **Match each file's existing style.** The hooks are `#!/bin/bash` + `set -u` + `[ ]`/`case` — do NOT convert them to `[[ ]]`/`set -euo pipefail`. `claude-sandbox` is `#!/usr/bin/env bash` + `set -euo pipefail`; keep `${VAR:-}` guards for any new variable reads.
- **Tests** are `node:assert`, run via `node tests/<file>.test.js`, spawning bash via `node:child_process`; each test file cleans up its temp dirs with `fs.rmSync(dir, { recursive: true, force: true })` and prints `ALL PASS` on success (match the style of `tests/dotsync-sync.test.js` / `tests/claude-settings-merge.test.js`).
- **Branch:** general-repo work happens on `chore/zero-lithic-cleanup` (off `main`). The work repo `~/work-laptop-config` commits directly to its own `main` (symlink-farm backup convention).
- Source-file name encoding: chezmoi `executable_` prefix → +x on the deployed target; `private_dot_claude/` → `~/.claude/`. Edit the source files under `home/`, never the deployed copies.

---

## Setup (once, before Task 1)

```bash
cd ~/.local/share/chezmoi
git switch -c chore/zero-lithic-cleanup
dotsync check   # baseline — expect "check: clean"
```

---

## File Structure

General repo (`~/.local/share/chezmoi/home/`):
- `private_dot_claude/hooks/executable_auto-format.sh` — modify: source `local.env`, gate vault-markdown skip on `CLAUDE_VAULT_DIR`.
- `private_dot_claude/hooks/executable_check-before-stop.sh` — modify: source `local.env`, exempt `$CLAUDE_VAULT_DIR`, delete retired `~/.dotfiles` bare-repo logic.
- `private_dot_claude/hooks/executable_watch-paths.sh` — modify: source `local.env`, watch vault `raw/` only when configured.
- `private_dot_claude/sandbox/executable_resolve-sandbox-settings.sh` — **create**: print base, or base⊕overlay merged at launch.
- `private_dot_claude/sandbox/settings.json` → `settings.base.json` — **rename** + strip work-MCP denies.
- `private_dot_claude/sandbox/executable_claude-sandbox` — modify: source `local.env`, resolve+mount settings, vault session-log fallback.
- `private_dot_claude/sandbox/executable_entrypoint.sh` — modify: generic cloud-MCP wording.
- `private_dot_claude/agents/migration-reviewer.md` — modify: generic domain wording.
- `private_dot_claude/hooks/executable_log-permission.test.js` — modify: neutral fixture path.
- `.chezmoitemplates/settings.base.json` — modify: remove two PagerDuty read perms.
- `private_dot_claude/commands/capture-session.md` — **delete** (moved to work repo).

General-repo tests (`~/.local/share/chezmoi/tests/`):
- `hooks-vault-param.test.js` — **create**.
- `resolve-sandbox-settings.test.js` — **create**.
- `sandbox-settings-base.test.js` — **create**.

Work repo (`~/work-laptop-config/`):
- `.config/claude/local.env` — **create** (`CLAUDE_VAULT_DIR`).
- `.config/claude/sandbox-settings.work.json` — **create** (work-MCP sandbox denies).
- `.config/claude/settings.work.json` — modify: add the two PagerDuty read perms.
- `.claude/commands/capture-session.md` — **create** (moved).

---

## Task 1: Parameterize the shared hooks (vault extension point)

**Files:**
- Modify: `home/private_dot_claude/hooks/executable_auto-format.sh`
- Modify: `home/private_dot_claude/hooks/executable_check-before-stop.sh`
- Modify: `home/private_dot_claude/hooks/executable_watch-paths.sh`
- Test: `tests/hooks-vault-param.test.js` (create)

**Interfaces:**
- Produces: the convention that general hooks read an optional `~/.config/claude/local.env` exporting `CLAUDE_VAULT_DIR`. When unset/empty, all vault-specific behaviour is skipped.

- [ ] **Step 1: Write the failing test** — create `tests/hooks-vault-param.test.js`:

```js
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOKS = path.join(__dirname, '..', 'home', 'private_dot_claude', 'hooks');
const AUTO_FORMAT = path.join(HOOKS, 'executable_auto-format.sh');
const CHECK_STOP = path.join(HOOKS, 'executable_check-before-stop.sh');
const WATCH = path.join(HOOKS, 'executable_watch-paths.sh');

const cleanups = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(d); return d; }
function writeLocalEnv(home, vaultDir) {
  const dir = path.join(home, '.config', 'claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local.env'), `CLAUDE_VAULT_DIR=${JSON.stringify(vaultDir)}\n`);
}
function runHook(hook, { input = '', home, cwd, extraPath } = {}) {
  const env = { ...process.env, HOME: home };
  if (extraPath) env.PATH = extraPath + ':' + process.env.PATH;
  try {
    const stdout = execFileSync('bash', [hook], { input, env, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status };
  }
}

// ---- auto-format.sh: vault markdown skipped, non-vault markdown formatted ----
{
  const home = tmp('hookhome-');
  const vault = path.join(home, 'Vault');
  fs.mkdirSync(vault, { recursive: true });
  writeLocalEnv(home, vault);
  const bin = tmp('bin-');
  const marker = path.join(bin, 'called.log');
  fs.writeFileSync(path.join(bin, 'prettier'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });

  const vfile = path.join(vault, 'note.md');
  fs.writeFileSync(vfile, '# x');
  runHook(AUTO_FORMAT, { input: JSON.stringify({ tool_input: { file_path: vfile } }), home, extraPath: bin });
  assert.ok(!fs.existsSync(marker), 'vault markdown must NOT be formatted');

  const ofile = path.join(home, 'other.md');
  fs.writeFileSync(ofile, '# y');
  runHook(AUTO_FORMAT, { input: JSON.stringify({ tool_input: { file_path: ofile } }), home, extraPath: bin });
  assert.ok(fs.existsSync(marker), 'non-vault markdown must be formatted');
}

// ---- check-before-stop.sh: protected-branch block, vault exemption, dead paths removed ----
{
  const home = tmp('hookhome-');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one'); git('add', 'a.txt'); git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two'); git('add', 'a.txt');           // stage change on main
  const top = git('rev-parse', '--show-toplevel').trim();                            // realpath (macOS /tmp symlink)

  const r1 = runHook(CHECK_STOP, { input: '{}', home, cwd: repo });
  assert.match(r1.stdout, /"decision":\s*"block"/, 'staged changes on main must block');

  writeLocalEnv(home, top);
  const r2 = runHook(CHECK_STOP, { input: '{}', home, cwd: repo });
  assert.doesNotMatch(r2.stdout, /"decision":\s*"block"/, 'vault repo is exempt');
  assert.strictEqual(r2.status, 0);

  const src = fs.readFileSync(CHECK_STOP, 'utf8');
  assert.ok(!src.includes('.dotfiles'), 'retired ~/.dotfiles logic removed');
  assert.ok(!/My_Vault/.test(src), 'hardcoded My_Vault removed');
}

// ---- watch-paths.sh: vault raw/ watched only when configured ----
{
  const home = tmp('hookhome-');
  const vault = path.join(home, 'Vault');
  fs.mkdirSync(path.join(vault, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
  writeLocalEnv(home, vault);
  const r1 = runHook(WATCH, { input: JSON.stringify({ source: 'startup' }), home });
  const w1 = JSON.parse(r1.stdout).hookSpecificOutput.watchPaths;
  assert.ok(w1.includes(path.join(vault, 'raw')), 'vault raw/ watched when configured');
  assert.ok(w1.includes(path.join(home, '.claude', 'rules')), 'rules dir always watched');

  const home2 = tmp('hookhome-');
  fs.mkdirSync(path.join(home2, '.claude', 'rules'), { recursive: true });
  const r2 = runHook(WATCH, { input: JSON.stringify({ source: 'startup' }), home: home2 });
  const w2 = JSON.parse(r2.stdout).hookSpecificOutput.watchPaths;
  assert.deepStrictEqual(w2, [path.join(home2, '.claude', 'rules')], 'no vault -> only rules dir');

  const r3 = runHook(WATCH, { input: JSON.stringify({ source: 'resume' }), home });
  assert.strictEqual(r3.stdout.trim(), '', 'non-startup source produces no output');
}

for (const c of cleanups) fs.rmSync(c, { recursive: true, force: true });
console.log('ALL PASS');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ~/.local/share/chezmoi && node tests/hooks-vault-param.test.js`
Expected: FAIL (vault markdown currently matches the hardcoded `*/My_Vault/*`, not `$CLAUDE_VAULT_DIR`; `.dotfiles` still present in check-before-stop; vault `raw/` hardcoded to `$HOME/Documents/My_Vault`).

- [ ] **Step 3: Edit `executable_auto-format.sh`** — source `local.env` after `set -u`, and replace the `*.md` case.

Insert after the `set -u` line (currently line 6):

```bash
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
```

Replace the `*.md)` case block:

```bash
  *.md)
    # Skip vault markdown — Obsidian formatting (wikilinks, callouts) is non-standard
    case "$FILE_PATH" in
      */My_Vault/*) ;;
      *) run_if_installed prettier --write --log-level=silent "$FILE_PATH" >/dev/null ;;
    esac
    ;;
```

with:

```bash
  *.md)
    # Skip vault markdown — Obsidian formatting (wikilinks, callouts) is non-standard.
    # The vault location is machine-specific; CLAUDE_VAULT_DIR (from local.env) supplies
    # it when present. With no vault configured, all markdown is formatted normally.
    _skip_md=false
    if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
      case "$FILE_PATH" in
        "$CLAUDE_VAULT_DIR"/*) _skip_md=true ;;
      esac
    fi
    if [ "$_skip_md" = false ]; then
      run_if_installed prettier --write --log-level=silent "$FILE_PATH" >/dev/null
    fi
    ;;
```

- [ ] **Step 4: Edit `executable_check-before-stop.sh`** — source `local.env` after `set -u`:

```bash
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
```

Replace the toplevel exemption + bare-repo block (currently lines 17–28):

```bash
# Skip repos that commit directly to main by convention.
# Check both toplevel path and remote URL to handle worktrees at different paths.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
case "$TOPLEVEL" in
  "$HOME/.dotfiles"|"$HOME/Documents/My_Vault") exit 0 ;;
esac

# Skip bare dotfiles repo (GIT_DIR=~/.dotfiles) — commits directly to main by convention.
GIT_DIR_VAL=$(git rev-parse --git-dir 2>/dev/null)
case "$GIT_DIR_VAL" in
  "$HOME/.dotfiles"|"$HOME/.dotfiles/"*) exit 0 ;;
esac
```

with:

```bash
# Skip repos that commit directly to main by convention.
# Check both toplevel path and remote URL to handle worktrees at different paths.
TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "${CLAUDE_VAULT_DIR:-}" ] && [ "$TOPLEVEL" = "$CLAUDE_VAULT_DIR" ]; then
  exit 0
fi
```

Replace the remote-URL match (currently lines 30–34):

```bash
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
case "$REMOTE_URL" in
  *My_Vault*|*dotfiles*) exit 0 ;;
esac
```

with:

```bash
REMOTE_URL=$(git remote get-url origin 2>/dev/null)
case "$REMOTE_URL" in
  *dotfiles*) exit 0 ;;
esac
```

- [ ] **Step 5: Edit `executable_watch-paths.sh`** — source `local.env` after `set -u`:

```bash
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
```

Replace the vault watch block (currently lines 13–15):

```bash
# Watch the vault raw/ directory for new ingest material
RAW_DIR="$HOME/Documents/My_Vault/raw"
[ -d "$RAW_DIR" ] && PATHS=$(jq -n --arg p "$RAW_DIR" '[$p]')
```

with:

```bash
# Watch the vault raw/ directory for new ingest material (only when a vault is configured)
if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
  RAW_DIR="$CLAUDE_VAULT_DIR/raw"
  [ -d "$RAW_DIR" ] && PATHS=$(jq -n --arg p "$RAW_DIR" '[$p]')
fi
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd ~/.local/share/chezmoi && node tests/hooks-vault-param.test.js`
Expected: `ALL PASS`

- [ ] **Step 7: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/private_dot_claude/hooks/executable_auto-format.sh \
        home/private_dot_claude/hooks/executable_check-before-stop.sh \
        home/private_dot_claude/hooks/executable_watch-paths.sh \
        tests/hooks-vault-param.test.js
git commit -m "Parameterize vault path in shared hooks via CLAUDE_VAULT_DIR

The general hooks no longer hardcode the work vault path. They source an
optional ~/.config/claude/local.env (work-repo-owned) and gate vault-specific
behaviour on CLAUDE_VAULT_DIR, behaving as generic vault-unaware tools when it
is unset. Also removes the retired ~/.dotfiles bare-repo logic from
check-before-stop (that repo was migrated to chezmoi)."
```

---

## Task 2: Sandbox settings base⊕overlay + resolve helper + claude-sandbox rewire

**Files:**
- Create: `home/private_dot_claude/sandbox/executable_resolve-sandbox-settings.sh`
- Rename: `home/private_dot_claude/sandbox/settings.json` → `settings.base.json` (+ strip work denies)
- Modify: `home/private_dot_claude/sandbox/executable_claude-sandbox`
- Test: `tests/resolve-sandbox-settings.test.js` (create), `tests/sandbox-settings-base.test.js` (create)

**Interfaces:**
- Consumes: `~/.local/bin/claude-settings-merge FILE [FILE...]` (deep-merge JSON: objects by key, arrays concat+dedupe, scalars overlay-wins, missing file = `{}`).
- Produces: `resolve-sandbox-settings.sh <base.json> <work-overlay.json>` → prints to stdout the path to mount (base path if no/failed overlay, else a merged temp file under `${TMPDIR:-/tmp}`); always exits 0. Consumed by `claude-sandbox` as `$SANDBOX_SETTINGS`.

- [ ] **Step 1: Write the failing resolve-helper test** — create `tests/resolve-sandbox-settings.test.js`:

```js
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HELPER = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'executable_resolve-sandbox-settings.sh');
const MERGE_SRC = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');

const cleanups = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); cleanups.push(d); return d; }
function run(args, { home, pathDirs } = {}) {
  const env = { ...process.env };
  if (home) env.HOME = home;
  if (pathDirs) env.PATH = pathDirs.join(':');
  try {
    const stdout = execFileSync('bash', [HELPER, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { stdout: stdout.trim(), stderr: '', status: 0 };
  } catch (e) {
    return { stdout: (e.stdout || '').trim(), stderr: e.stderr || '', status: e.status };
  }
}

const d = tmp('rss-');
const base = path.join(d, 'base.json');
fs.writeFileSync(base, JSON.stringify({ permissions: { deny: ['mcp__base__only'] } }));
const overlay = path.join(d, 'overlay.json');
fs.writeFileSync(overlay, JSON.stringify({ permissions: { deny: ['mcp__work__only'] } }));

const okBin = tmp('okbin-');
fs.writeFileSync(path.join(okBin, 'claude-settings-merge'),
  `#!/bin/sh\nexec node ${JSON.stringify(MERGE_SRC)} "$@"\n`, { mode: 0o755 });

// 1. overlay absent -> base path
assert.strictEqual(run([base, path.join(d, 'nope.json')]).stdout, base, 'absent overlay -> base');

// 2. overlay present + tool available -> merged temp path with both denies
{
  const r = run([base, overlay], { pathDirs: [okBin, '/usr/bin', '/bin'] });
  assert.notStrictEqual(r.stdout, base, 'merged path differs from base');
  assert.ok(fs.existsSync(r.stdout), 'merged file exists');
  const merged = JSON.parse(fs.readFileSync(r.stdout, 'utf8'));
  assert.ok(merged.permissions.deny.includes('mcp__base__only'), 'keeps base deny');
  assert.ok(merged.permissions.deny.includes('mcp__work__only'), 'adds work deny');
  cleanups.push(r.stdout);
}

// 3. tool missing -> base path + warning
{
  const emptyHome = tmp('emptyhome-');
  const r = run([base, overlay], { home: emptyHome, pathDirs: ['/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'missing tool -> base');
  assert.match(r.stderr, /not found/, 'warns when tool missing');
}

// 4. tool fails -> base path + warning
{
  const failBin = tmp('failbin-');
  fs.writeFileSync(path.join(failBin, 'claude-settings-merge'), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  const r = run([base, overlay], { pathDirs: [failBin, '/usr/bin', '/bin'] });
  assert.strictEqual(r.stdout, base, 'merge failure -> base');
  assert.match(r.stderr, /merge failed/, 'warns when merge fails');
}

for (const c of cleanups) fs.rmSync(c, { recursive: true, force: true });
console.log('ALL PASS');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd ~/.local/share/chezmoi && node tests/resolve-sandbox-settings.test.js`
Expected: FAIL (`resolve-sandbox-settings.sh` does not exist yet).

- [ ] **Step 3: Create `home/private_dot_claude/sandbox/executable_resolve-sandbox-settings.sh`:**

```bash
#!/bin/bash
# Resolve which settings JSON the sandbox should mount.
# Usage: resolve-sandbox-settings.sh <base.json> <work-overlay.json>
# If the overlay exists, deep-merge base+overlay via claude-settings-merge and print
# the path to the merged temp file; otherwise (or on any failure) print the base path.
# Never fails the caller — a missing/broken merge tool falls back to the base.
set -u

BASE="$1"
OVERLAY="$2"

if [ ! -f "$OVERLAY" ]; then
  printf '%s\n' "$BASE"
  exit 0
fi

MERGE="$(command -v claude-settings-merge 2>/dev/null || true)"
if [ -z "$MERGE" ] && [ -x "$HOME/.local/bin/claude-settings-merge" ]; then
  MERGE="$HOME/.local/bin/claude-settings-merge"
fi
if [ -z "$MERGE" ]; then
  echo "resolve-sandbox-settings: claude-settings-merge not found; mounting base only" >&2
  printf '%s\n' "$BASE"
  exit 0
fi

OUT="$(mktemp "${TMPDIR:-/tmp}/sandbox-settings-XXXXXX.json")"
if "$MERGE" "$BASE" "$OVERLAY" >"$OUT" 2>/dev/null; then
  printf '%s\n' "$OUT"
else
  echo "resolve-sandbox-settings: merge failed; mounting base only" >&2
  rm -f "$OUT"
  printf '%s\n' "$BASE"
fi
```

- [ ] **Step 4: Run the resolve-helper test to confirm it passes**

Run: `cd ~/.local/share/chezmoi && node tests/resolve-sandbox-settings.test.js`
Expected: `ALL PASS`

- [ ] **Step 5: Write the failing base-settings test** — create `tests/sandbox-settings-base.test.js`:

```js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BASE = path.join(__dirname, '..', 'home', 'private_dot_claude', 'sandbox', 'settings.base.json');
const raw = fs.readFileSync(BASE, 'utf8');
const parsed = JSON.parse(raw);                                   // must be valid JSON
assert.ok(parsed.permissions && Array.isArray(parsed.permissions.deny), 'has permissions.deny');
assert.ok(!/lithic|grafana|pagerduty/i.test(raw), 'no work-MCP vendor names in base');
console.log('ALL PASS');
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `cd ~/.local/share/chezmoi && node tests/sandbox-settings-base.test.js`
Expected: FAIL (`settings.base.json` does not exist yet — still named `settings.json`, and it contains the vendor names).

- [ ] **Step 7: Rename + strip the sandbox settings**

```bash
cd ~/.local/share/chezmoi
git mv home/private_dot_claude/sandbox/settings.json home/private_dot_claude/sandbox/settings.base.json
```

Then edit `home/private_dot_claude/sandbox/settings.base.json`: in `permissions.deny`, replace this block (the Drive entries through the closing `]`):

```json
      "mcp__claude_ai_Google_Drive__create_*",
      "mcp__claude_ai_Google_Drive__copy_*",

      "mcp__claude_ai_Pagerduty__create_*",
      "mcp__claude_ai_Pagerduty__update_*",
      "mcp__claude_ai_Pagerduty__manage_*",
      "mcp__claude_ai_Pagerduty__add_*",
      "mcp__claude_ai_Pagerduty__remove_*",
      "mcp__claude_ai_Pagerduty__delete_*",
      "mcp__claude_ai_Pagerduty__start_*",
      "mcp__claude_ai_Pagerduty__append_*",

      "mcp__claude_ai_Lithic_API_Docs__execute-request",
      "mcp__claude_ai_Lithic_-_Stainless_-_Beta__execute",

      "mcp__claude_ai_Sentry__authenticate",
      "mcp__claude_ai_Sentry__complete_authentication",

      "mcp__claude_ai_Privacy_MCP__authenticate",
      "mcp__claude_ai_Privacy_MCP__complete_authentication",

      "mcp__grafana__create_*",
      "mcp__grafana__update_*",
      "mcp__grafana__alerting_manage_*",
      "mcp__grafana__add_*",
      "mcp__grafana__install_*"
    ]
```

with (Pagerduty/Lithic/Grafana removed; trailing comma dropped from the new last entry):

```json
      "mcp__claude_ai_Google_Drive__create_*",
      "mcp__claude_ai_Google_Drive__copy_*",

      "mcp__claude_ai_Sentry__authenticate",
      "mcp__claude_ai_Sentry__complete_authentication",

      "mcp__claude_ai_Privacy_MCP__authenticate",
      "mcp__claude_ai_Privacy_MCP__complete_authentication"
    ]
```

- [ ] **Step 8: Run the base-settings test to confirm it passes**

Run: `cd ~/.local/share/chezmoi && node tests/sandbox-settings-base.test.js`
Expected: `ALL PASS`

- [ ] **Step 9: Rewire `executable_claude-sandbox`** — after the `STATE_DIR=...` line (currently line 10), insert:

```bash
# Machine/work-specific values (e.g. CLAUDE_VAULT_DIR) for an optional work overlay.
if [ -f "$HOME/.config/claude/local.env" ]; then
  . "$HOME/.config/claude/local.env"
fi
# Resolve the settings file to mount: base, or base+work-overlay merged at launch.
SANDBOX_SETTINGS="$("$SANDBOX_DIR/resolve-sandbox-settings.sh" "$SANDBOX_DIR/settings.base.json" "$HOME/.config/claude/sandbox-settings.work.json")"
```

Replace the first mount line (currently line 1343):

```bash
  -v "$SANDBOX_DIR/settings.json:/home/claudebot/.claude-defaults/settings.json:ro"
```

with:

```bash
  -v "$SANDBOX_SETTINGS:/home/claudebot/.claude-defaults/settings.json:ro"
```

Replace the second mount line (currently line 1438):

```bash
    -v "$SANDBOX_DIR/settings.json:/home/claudebot/.claude/settings.json:ro" \
```

with:

```bash
    -v "$SANDBOX_SETTINGS:/home/claudebot/.claude/settings.json:ro" \
```

Replace the vault session-log line (currently line 699):

```bash
  local vault_dir="$HOME/Documents/My_Vault/Work/Sessions/$repo_name"
```

with:

```bash
  local vault_dir
  if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
    vault_dir="$CLAUDE_VAULT_DIR/Work/Sessions/$repo_name"
  else
    vault_dir="$HOME/.claude/sandbox-sessions/$repo_name"
  fi
```

- [ ] **Step 10: Syntax-check the rewired launcher + confirm the host source path is gone**

Run:
```bash
cd ~/.local/share/chezmoi
bash -n home/private_dot_claude/sandbox/executable_claude-sandbox && echo SYNTAX_OK
grep -n 'SANDBOX_DIR/settings.json' home/private_dot_claude/sandbox/executable_claude-sandbox || echo "no stale host settings.json reference"
```
Expected: `SYNTAX_OK` and `no stale host settings.json reference`.

- [ ] **Step 11: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/private_dot_claude/sandbox/executable_resolve-sandbox-settings.sh \
        home/private_dot_claude/sandbox/settings.base.json \
        home/private_dot_claude/sandbox/executable_claude-sandbox \
        tests/resolve-sandbox-settings.test.js tests/sandbox-settings-base.test.js
git commit -m "Split sandbox settings into base + work overlay merged at launch

The general sandbox settings (settings.base.json) no longer name the Lithic,
PagerDuty, or Grafana MCPs. claude-sandbox resolves the settings to mount via a
new resolve-sandbox-settings.sh helper: base alone, or base deep-merged with an
optional ~/.config/claude/sandbox-settings.work.json (work-repo-owned) when
present. The vault session-log dir is likewise gated on CLAUDE_VAULT_DIR with a
neutral ~/.claude/sandbox-sessions fallback."
```

---

## Task 3: Generic wording scrub

**Files:**
- Modify: `home/private_dot_claude/sandbox/executable_entrypoint.sh`
- Modify: `home/private_dot_claude/agents/migration-reviewer.md`
- Modify: `home/private_dot_claude/hooks/executable_log-permission.test.js`

- [ ] **Step 1: Edit `executable_entrypoint.sh`** — replace the cloud-MCP report line (currently line 104):

```bash
  echo "- **Cloud MCPs**: write operations denied (Atlassian, Slack, Notion, Gmail, Drive, Calendar, PagerDuty, Lithic, Grafana). Read-only access only if authenticated."
```

with:

```bash
  echo "- **Cloud MCPs**: write operations denied (Atlassian, Slack, Notion, Gmail, Drive, Calendar, and any configured org MCPs). Read-only access only if authenticated."
```

- [ ] **Step 2: Edit `migration-reviewer.md`** — replace the intro sentence (currently line 8):

```markdown
You are a database migration safety reviewer for a high-volume card-issuing platform. Migrations run against production databases that process financial transactions. Downtime or data corruption is not acceptable.
```

with:

```markdown
You are a database migration safety reviewer for a high-volume production platform. Migrations run against production databases that store critical business data. Downtime or data corruption is not acceptable.
```

(Leave the `### PCI/Compliance` section unchanged.)

- [ ] **Step 3: Edit `executable_log-permission.test.js`** — replace the fixture test (currently lines 181–184):

```js
test("summarize leaves non-temp vault paths untouched", () => {
  const cmd = 'node "C:/Users/daniel/My_Vault/.claude/scripts/check-links.js"';
  assert.strictEqual(m.summarize("Bash", { command: cmd }), cmd);
});
```

with:

```js
test("summarize leaves non-temp paths untouched", () => {
  const cmd = 'node "C:/Users/daniel/notes/.claude/scripts/check-links.js"';
  assert.strictEqual(m.summarize("Bash", { command: cmd }), cmd);
});
```

- [ ] **Step 4: Run the log-permission test suite to confirm it still passes**

Run: `cd ~/.local/share/chezmoi && node home/private_dot_claude/hooks/executable_log-permission.test.js`
Expected: the suite passes (all `node:test` tests pass; the fixture change is behaviour-neutral).

- [ ] **Step 5: Confirm the three files are clean of banned terms**

Run:
```bash
cd ~/.local/share/chezmoi
grep -niE 'lithic|grafana|pagerduty|card.issu|my_vault' \
  home/private_dot_claude/sandbox/executable_entrypoint.sh \
  home/private_dot_claude/agents/migration-reviewer.md \
  home/private_dot_claude/hooks/executable_log-permission.test.js || echo "clean"
```
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/private_dot_claude/sandbox/executable_entrypoint.sh \
        home/private_dot_claude/agents/migration-reviewer.md \
        home/private_dot_claude/hooks/executable_log-permission.test.js
git commit -m "Genericize Lithic-specific wording in general tooling

Drop named work vendors from the sandbox cloud-MCP report, replace the
card-issuing framing in the migration-reviewer agent with neutral wording, and
neutralize a My_Vault test fixture path. PCI/SOC2 references are retained as
industry-standard compliance concepts."
```

---

## Task 4: Move the two PagerDuty read perms from the main settings base to the work overlay

**Files:**
- Modify: `home/.chezmoitemplates/settings.base.json`
- Modify: `~/work-laptop-config/.config/claude/settings.work.json`

**Interfaces:**
- Consumes: the base⊕overlay merge done by `home/private_dot_claude/modify_settings.json.tmpl` via `claude-settings-merge` (arrays concat+dedupe). Moving allow entries from base to overlay leaves the merged result on the work laptop unchanged.

- [ ] **Step 1: Edit `home/.chezmoitemplates/settings.base.json`** — in `permissions.allow`, remove the two PagerDuty entries. Replace:

```json
      "mcp__claude_ai_Google_Drive__download_*",
      "mcp__claude_ai_Pagerduty__get_*",
      "mcp__claude_ai_Pagerduty__list_*",
      "mcp__claude_ai_Slack__slack_read_*",
```

with:

```json
      "mcp__claude_ai_Google_Drive__download_*",
      "mcp__claude_ai_Slack__slack_read_*",
```

- [ ] **Step 2: Edit `~/work-laptop-config/.config/claude/settings.work.json`** — append the two PagerDuty entries to `permissions.allow`. Replace:

```json
      "mcp__claude_ai_Lithic_-_Stainless_-_Beta__search_docs"
    ]
```

with:

```json
      "mcp__claude_ai_Lithic_-_Stainless_-_Beta__search_docs",
      "mcp__claude_ai_Pagerduty__get_*",
      "mcp__claude_ai_Pagerduty__list_*"
    ]
```

- [ ] **Step 3: Verify merge equivalence** (the work laptop still gets both perms; the base alone does not)

Run:
```bash
cd ~/.local/share/chezmoi
echo "base alone (expect 0):"
grep -c Pagerduty home/.chezmoitemplates/settings.base.json
echo "merged base+overlay (expect 2):"
node home/dot_local/bin/executable_claude-settings-merge \
  home/.chezmoitemplates/settings.base.json \
  ~/work-laptop-config/.config/claude/settings.work.json | grep -c Pagerduty
```
Expected: `0` for base alone, `2` for the merged output. Also confirm both files are valid JSON:
```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("base OK")' home/.chezmoitemplates/settings.base.json
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("overlay OK")' ~/work-laptop-config/.config/claude/settings.work.json
```
Expected: `base OK` and `overlay OK`.

- [ ] **Step 4: Commit** (two repos)

```bash
cd ~/.local/share/chezmoi
git add home/.chezmoitemplates/settings.base.json
git commit -m "Move PagerDuty read perms from settings base to the work overlay

The main settings base no longer references the PagerDuty MCP; its get_/list_
read allows now live in the work overlay (settings.work.json), so the work
laptop's merged settings are unchanged while the general base stays vendor-free."

cd ~/work-laptop-config
git add .config/claude/settings.work.json
git commit -m "Add PagerDuty read perms to the work settings overlay

Mirrors their removal from the general dotfiles settings base; the merged
~/.claude/settings.json on the work laptop is unchanged."
```

---

## Task 5: Cutover — move capture-session, add work-repo extension files, deploy, verify

**Files:**
- Create: `~/work-laptop-config/.claude/commands/capture-session.md` (copied from general)
- Create: `~/work-laptop-config/.config/claude/local.env`
- Create: `~/work-laptop-config/.config/claude/sandbox-settings.work.json`
- Delete: `home/private_dot_claude/commands/capture-session.md`

- [ ] **Step 1: Copy `capture-session.md` to the work repo, then delete it from the general repo**

```bash
mkdir -p ~/work-laptop-config/.claude/commands
cp ~/.local/share/chezmoi/home/private_dot_claude/commands/capture-session.md \
   ~/work-laptop-config/.claude/commands/capture-session.md
cd ~/.local/share/chezmoi
git rm home/private_dot_claude/commands/capture-session.md
```

- [ ] **Step 2: Create `~/work-laptop-config/.config/claude/local.env`:**

```bash
# Machine/work-specific values sourced by the general Claude hooks and claude-sandbox.
# Present only on machines that have the work vault.
CLAUDE_VAULT_DIR="$HOME/Documents/My_Vault"
```

- [ ] **Step 3: Create `~/work-laptop-config/.config/claude/sandbox-settings.work.json`** (the work-MCP denies removed from the sandbox base in Task 2):

```json
{
  "permissions": {
    "deny": [
      "mcp__claude_ai_Pagerduty__create_*",
      "mcp__claude_ai_Pagerduty__update_*",
      "mcp__claude_ai_Pagerduty__manage_*",
      "mcp__claude_ai_Pagerduty__add_*",
      "mcp__claude_ai_Pagerduty__remove_*",
      "mcp__claude_ai_Pagerduty__delete_*",
      "mcp__claude_ai_Pagerduty__start_*",
      "mcp__claude_ai_Pagerduty__append_*",
      "mcp__claude_ai_Lithic_API_Docs__execute-request",
      "mcp__claude_ai_Lithic_-_Stainless_-_Beta__execute",
      "mcp__grafana__create_*",
      "mcp__grafana__update_*",
      "mcp__grafana__alerting_manage_*",
      "mcp__grafana__add_*",
      "mcp__grafana__install_*"
    ]
  }
}
```

- [ ] **Step 4: Apply the general-repo changes, then deploy the work-repo symlinks**

Order matters: `chezmoi apply` first (it removes the old deployed `capture-session.md` and renames the sandbox settings), then `install.sh` (re-creates `capture-session.md` as a symlink and links the two new `.config/claude` files).

```bash
chezmoi apply --source ~/.local/share/chezmoi
~/work-laptop-config/install.sh
# Stage the new work-repo files NOW so `dotsync check` (which derives work ownership
# from `git ls-files`) sees them as owned, not as orphans. Verify before committing.
git -C ~/work-laptop-config add -A
```

If `chezmoi apply` fails with "operation not permitted" (sandbox blocks rename into `$HOME`), re-run it with the command sandbox disabled.

- [ ] **Step 5: Verify the acceptance gate**

```bash
cd ~/.local/share/chezmoi
echo "=== banned terms in general repo (expect nothing) ==="
grep -rniE 'lithic|grafana|pagerduty|card.issu|my_vault' home/ --include='*' | grep -v '/docs/' || echo "CLEAN"
echo "=== dotsync check (expect: check: clean) ==="
dotsync check
echo "=== work-repo symlinks deployed ==="
ls -l ~/.config/claude/local.env ~/.config/claude/sandbox-settings.work.json ~/.claude/commands/capture-session.md
echo "=== sandbox base deployed, old settings.json gone ==="
test -f ~/.claude/sandbox/settings.base.json && echo "base present"
test ! -e ~/.claude/sandbox/settings.json && echo "old settings.json removed"
echo "=== regenerated main settings still has PagerDuty read perms (work laptop) ==="
grep -c Pagerduty ~/.claude/settings.json
```
Expected: `CLEAN`; `check: clean`; the three symlinks point into `~/work-laptop-config`; `base present`; `old settings.json removed`; PagerDuty count `>= 2`.

- [ ] **Step 6: Sanity-check the deployed sandbox resolve path** (overlay present → merged contains a work deny)

```bash
RESOLVED="$(~/.claude/sandbox/resolve-sandbox-settings.sh ~/.claude/sandbox/settings.base.json ~/.config/claude/sandbox-settings.work.json)"
echo "resolved: $RESOLVED"
grep -c grafana "$RESOLVED"   # expect >= 1 (overlay merged in)
# overlay-absent path falls back to base:
~/.claude/sandbox/resolve-sandbox-settings.sh ~/.claude/sandbox/settings.base.json /nonexistent.json
```
Expected: `resolved:` a temp path; grafana count `>= 1`; the absent-overlay call prints the base path.

- [ ] **Step 7: Commit + push both repos**

```bash
cd ~/.local/share/chezmoi
git add -A
git commit -m "Move capture-session command to the work repo

capture-session is wholly vault/work-domain (routes findings to Lithic and
Processing-Team vault pages) and cannot be genericized, so it now lives in
work-laptop-config and is symlinked in. Completes the general-repo zero-Lithic
cleanup: grep for lithic/grafana/pagerduty/card-issuing/My_Vault is now empty."
git push -u origin chore/zero-lithic-cleanup

cd ~/work-laptop-config
git add -A
git commit -m "Add vault local.env, sandbox work overlay, and capture-session command

Holds the work-specific pieces relocated out of the general dotfiles repo:
CLAUDE_VAULT_DIR (consumed by the general hooks + claude-sandbox), the sandbox
work-MCP deny overlay (merged into sandbox settings at launch), and the
vault-domain capture-session command."
git push
```

---

## Notes for the executor

- The general-repo branch `chore/zero-lithic-cleanup` is merged to `main` at the end via **superpowers:finishing-a-development-branch** (after the whole-branch review), not inside a task.
- The work repo has no feature-branch workflow; it commits to its own `main` and pushes directly.
- `git push` over SSH and `chezmoi apply` renames into `$HOME` may require the command sandbox to be disabled — retry those commands with the sandbox off if they fail with a connection/permission error.
- Do not edit deployed copies under `~/.claude` directly; edit the chezmoi source under `home/` and `chezmoi apply`.
