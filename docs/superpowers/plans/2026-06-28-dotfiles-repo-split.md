# Dotfiles Repo Split — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chezmoi dotfiles repo (`DanielH2018/dotfiles`) 100% work-agnostic by moving all Lithic/laptop-specific config into a new private repo (`work-laptop-config`), composed back together on the work laptop via generic extension points and a `settings.json` base+overlay deep-merge.

**Architecture:** The general repo keeps only portable config plus generic extension points (`source local.zsh if present`, `@import CLAUDE.local.md`, gitconfig `[include]`, and a `modify_settings.json` that deep-merges a general base with an optional work overlay). The work repo is a symlink farm (`install.sh` links its files into `$HOME`). `~/.claude/settings.json` is *generated* (base ⊕ overlay), not owned by either repo.

**Tech Stack:** chezmoi (Go templates + `modify_` scripts + `.chezmoitemplates`), Node (deep-merge helper + tests, run via `node:test`-style assert scripts matching the repo's existing `tests/*.test.js`), POSIX sh (install.sh, modify script), git.

**Spec:** `docs/superpowers/specs/2026-06-28-dotfiles-two-repo-split-design.md`

**Scope note:** This is Plan 1 (the split). The `dotsync` preservation subsystem is Plan 2 — it depends on both repos existing and is written separately so each plan ships working software. Where this plan references `dotsync`/manifests, it only *prepares* for them (e.g. the work repo ships a `manifest.d/50-work.json` fragment that Plan 2 consumes).

## Global Constraints

- Commit signing is on (1Password SSH agent). Never pass `--no-verify`. Default branch `main`; prefer rebase/fast-forward.
- chezmoi source root is `home/` (via `.chezmoiroot`). General-repo deployable entries go under `home/`; `docs/`, `tests/` stay at repo top level (not deployed).
- chezmoi name encoding: `dot_` → `.`, `private_` → 0600-ish, `executable_` → +x, `.tmpl` → templated, `modify_` → modify-script. A modify-script's name ends in the target's extension; do **not** run it via `node` (it would parse the script as JSON) — the modify script is POSIX sh and may *call* node on another file.
- Behavior-preserving cutover: after apply, the regenerated `~/.claude/settings.json` must be **semantically equal** to today's live file, `chezmoi diff` must be clean, and the shell + Claude must behave as before.
- The work repo is **private**; it contains no plaintext secrets (audited 2026-06-28), only `op://` references — keep it private regardless.
- A timestamped backup tarball (`~/.claude`, shell dotfiles, `~/.gitconfig`) is taken before the cutover task, per project practice.
- Work repo location: clone/work dir `~/work-laptop-config`; remote `git@github.com:DanielH2018/work-laptop-config.git` (private; create empty on GitHub first).
- **Merge semantics (settings.json):** objects deep-merge by key; arrays concatenate then de-dupe by JSON value; on a scalar conflict the overlay wins; a missing overlay file is treated as `{}`.

## File Structure

**General repo (`~/.local/share/chezmoi`):**
- `home/dot_local/bin/executable_claude-settings-merge` (new) — Node deep-merge CLI.
- `home/.chezmoitemplates/settings.base.json` (new) — the general settings base (not deployed standalone).
- `home/private_dot_claude/modify_settings.json` (rewrite → templated) — emits `merge(base, overlay-if-present)`.
- `home/dot_zshrc.tmpl`, `home/dot_zprofile.tmpl`, `home/dot_bash_profile.tmpl` (modify) — remove work blocks, add local-include.
- `home/private_dot_claude/CLAUDE.md.tmpl` (modify) — remove Lithic blocks + doc imports, add optional `@CLAUDE.local.md`.
- `home/dot_gitconfig.tmpl` (modify) — replace work name with `[include]`.
- `home/private_dot_claude/hooks/executable_redact-pan.sh` (delete — moves to work repo).
- `tests/claude-settings-merge.test.js` (new) — unit tests for the merge helper.

**Work repo (`~/work-laptop-config`):**
- `install.sh`, `uninstall.sh`, `README.md`
- `manifest.d/50-work.json` (consumed by Plan 2's `dotsync`)
- `.config/claude/settings.work.json`, `.claude/CLAUDE.local.md`, `.claude/docs/integrations.md`, `.claude/docs/enforcement.md`, `.claude/hooks/redact-pan.sh`
- `.config/zsh/local.zsh`, `.config/git/local.config`

---

### Task 1: Node deep-merge helper (`claude-settings-merge`)

**Files:**
- Create: `home/dot_local/bin/executable_claude-settings-merge`
- Test: `tests/claude-settings-merge.test.js`

**Interfaces:**
- Produces: a CLI `claude-settings-merge FILE [FILE...]` that reads each JSON file (skipping non-existent ones), deep-merges left→right per the Global Constraints semantics, and writes the result as pretty JSON (2-space, trailing newline) to stdout. Exit 2 on no args; exit 1 on JSON parse error (stderr names the file).

- [ ] **Step 1: Write the failing test**

Create `tests/claude-settings-merge.test.js`:

```js
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'home', 'dot_local', 'bin', 'executable_claude-settings-merge');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
const w = (name, obj) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; };
const run = (...args) => JSON.parse(execFileSync('node', [BIN, ...args], { encoding: 'utf8' }));

// 1. Objects deep-merge by key.
const base = w('base.json', { model: 'opus', enabledPlugins: { a: true }, env: { X: '1' } });
const over = w('over.json', { enabledPlugins: { b: true }, env: { Y: '2' } });
let out = run(base, over);
assert.strictEqual(out.model, 'opus');
assert.deepStrictEqual(out.enabledPlugins, { a: true, b: true });
assert.deepStrictEqual(out.env, { X: '1', Y: '2' });

// 2. Arrays concat + de-dupe by value.
const ba = w('ba.json', { deny: ['a', 'b'] });
const oa = w('oa.json', { deny: ['b', 'c'] });
assert.deepStrictEqual(run(ba, oa).deny, ['a', 'b', 'c']);

// 3. Overlay wins on scalar conflict.
assert.strictEqual(run(w('b3.json', { model: 'opus' }), w('o3.json', { model: 'sonnet' })).model, 'sonnet');

// 4. Missing overlay file is treated as {} (base returned unchanged).
assert.deepStrictEqual(run(base, path.join(tmp, 'does-not-exist.json')).enabledPlugins, { a: true });

// 5. Idempotent: merging the output with the same overlay is stable.
const once = execFileSync('node', [BIN, base, over], { encoding: 'utf8' });
const onceFile = w('once.json', JSON.parse(once));
const twice = execFileSync('node', [BIN, onceFile, over], { encoding: 'utf8' });
assert.strictEqual(once, twice);

console.log('ALL PASS');
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node tests/claude-settings-merge.test.js`
Expected: FAIL — `ENOENT`/cannot find `executable_claude-settings-merge`.

- [ ] **Step 3: Write the helper**

Create `home/dot_local/bin/executable_claude-settings-merge`:

```js
#!/usr/bin/env node
// Deep-merge JSON fragments left→right. Objects merge by key; arrays concat + de-dupe
// by JSON value; scalars: the later (overlay) value wins; a missing file is treated as {}.
const fs = require('node:fs');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const dedupe = (arr) => {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = JSON.stringify(item);
    if (!seen.has(k)) { seen.add(k); out.push(item); }
  }
  return out;
};

const merge = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return dedupe([...a, ...b]);
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = k in a ? merge(a[k], b[k]) : b[k];
    return out;
  }
  return b;
};

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: claude-settings-merge FILE [FILE...]\n');
  process.exit(2);
}
let acc = {};
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    process.stderr.write(`claude-settings-merge: cannot parse ${f}: ${e.message}\n`);
    process.exit(1);
  }
  acc = merge(acc, data);
}
process.stdout.write(JSON.stringify(acc, null, 2) + '\n');
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node tests/claude-settings-merge.test.js`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/dot_local/bin/executable_claude-settings-merge tests/claude-settings-merge.test.js
git commit -m "feat(settings): add claude-settings-merge deep-merge helper + tests"
```

---

### Task 2: Scaffold the work repo (`install.sh` / `uninstall.sh` / README)

**Files (in a new repo at `~/work-laptop-config`):**
- Create: `install.sh`, `uninstall.sh`, `README.md`
- Test: `install.sh` is testable via a `DOTFILES_TARGET` override (defaults to `$HOME`).

**Interfaces:**
- Produces: `install.sh` that, for every file under the repo's `payload` roots (`.claude/`, `.config/`), creates `$DOTFILES_TARGET/<relpath>` as a symlink to the repo file (parent dirs created; idempotent via `ln -sfn`). `uninstall.sh` removes exactly those symlinks (only if they point into the repo).

- [ ] **Step 1: Create the repo + structure**

```bash
mkdir -p ~/work-laptop-config
cd ~/work-laptop-config
git init -q
mkdir -p .claude/hooks .claude/docs .config/claude .config/zsh .config/git manifest.d
```

- [ ] **Step 2: Write the failing test**

Create `~/work-laptop-config/test-install.sh`:

```sh
#!/bin/sh
# Smoke test: install into a throwaway target, assert symlinks resolve, then uninstall.
set -e
cd "$(dirname "$0")"
TARGET="$(mktemp -d)"
trap 'rm -rf "$TARGET"' EXIT

# seed one payload file in each root so the test is meaningful
mkdir -p .config/zsh .claude/hooks
echo 'echo work' > .config/zsh/local.zsh
echo '#!/bin/sh' > .claude/hooks/redact-pan.sh

DOTFILES_TARGET="$TARGET" ./install.sh

[ -L "$TARGET/.config/zsh/local.zsh" ] || { echo "FAIL: local.zsh not a symlink"; exit 1; }
[ "$(cat "$TARGET/.config/zsh/local.zsh")" = "echo work" ] || { echo "FAIL: wrong content"; exit 1; }
[ -L "$TARGET/.claude/hooks/redact-pan.sh" ] || { echo "FAIL: hook not linked"; exit 1; }

DOTFILES_TARGET="$TARGET" ./install.sh   # idempotent: second run must not error
[ -L "$TARGET/.config/zsh/local.zsh" ] || { echo "FAIL: not idempotent"; exit 1; }

DOTFILES_TARGET="$TARGET" ./uninstall.sh
[ -e "$TARGET/.config/zsh/local.zsh" ] && { echo "FAIL: uninstall left link"; exit 1; }

echo "ALL PASS"
```

```bash
chmod +x ~/work-laptop-config/test-install.sh
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `~/work-laptop-config/test-install.sh`
Expected: FAIL — `./install.sh` not found / not executable.

- [ ] **Step 4: Write `install.sh` and `uninstall.sh`**

Create `~/work-laptop-config/install.sh`:

```sh
#!/bin/sh
# Symlink this repo's payload into $DOTFILES_TARGET (default $HOME). Idempotent.
set -eu
REPO="$(cd "$(dirname "$0")" && pwd)"
TARGET="${DOTFILES_TARGET:-$HOME}"
ROOTS=".claude .config manifest.d"

link_one() {
  src="$1"
  rel="${src#"$REPO"/}"
  dst="$TARGET/$rel"
  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
  echo "linked $dst -> $src"
}

for root in $ROOTS; do
  [ -d "$REPO/$root" ] || continue
  find "$REPO/$root" -type f -print | while IFS= read -r f; do link_one "$f"; done
done
```

Note: `manifest.d/50-work.json` links to `$TARGET/manifest.d/...`, but `dotsync` (Plan 2) expects it at `~/.config/dotsync/manifest.d/`. Place the fragment under `.config/dotsync/manifest.d/` in the repo (Task 8) so its relpath lands correctly; drop the standalone `manifest.d` root then. (Kept here only to show the link mechanism.)

Create `~/work-laptop-config/uninstall.sh`:

```sh
#!/bin/sh
# Remove only the symlinks that point back into this repo.
set -eu
REPO="$(cd "$(dirname "$0")" && pwd)"
TARGET="${DOTFILES_TARGET:-$HOME}"
ROOTS=".claude .config manifest.d"

for root in $ROOTS; do
  [ -d "$REPO/$root" ] || continue
  find "$REPO/$root" -type f -print | while IFS= read -r f; do
    rel="${f#"$REPO"/}"
    dst="$TARGET/$rel"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$f" ]; then
      rm "$dst"
      echo "removed $dst"
    fi
  done
done
```

```bash
chmod +x ~/work-laptop-config/install.sh ~/work-laptop-config/uninstall.sh
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `~/work-laptop-config/test-install.sh`
Expected: `ALL PASS`. Then remove the seed files: `rm ~/work-laptop-config/.config/zsh/local.zsh ~/work-laptop-config/.claude/hooks/redact-pan.sh`.

- [ ] **Step 6: README + initial commit**

Create `~/work-laptop-config/README.md` (bootstrap: `git clone … ~/work-laptop-config && ~/work-laptop-config/install.sh`; lists what the repo owns; notes it is consumed by `dotsync`). Then:

```bash
cd ~/work-laptop-config
printf '.DS_Store\n' > .gitignore
git add -A
git commit -m "feat: scaffold work-laptop-config symlink-farm installer + tests"
```

---

### Task 3: Classify and split `settings.json` into base + overlay

**Files:**
- Create: `home/.chezmoitemplates/settings.base.json` (general repo)
- Create: `~/work-laptop-config/.config/claude/settings.work.json` (work repo)

**Interfaces:**
- Consumes: `claude-settings-merge` (Task 1) for the reproduction check.
- Produces: `settings.base.json` (general keys) and `settings.work.json` (work-only additions) such that `merge(base, overlay)` is semantically equal to the current live `~/.claude/settings.json`.

- [ ] **Step 1: Snapshot the current file**

```bash
cp ~/.claude/settings.json /tmp/settings.current.json
```

- [ ] **Step 2: Classify keys (overlay = work; else base)**

Open `/tmp/settings.current.json`. A key/array-element belongs in the **overlay** iff it names a Lithic/work plugin, marketplace, hook, path, or env; otherwise **base**. Apply concretely:
- `enabledPlugins`: overlay gets `privacy-eng-tools@privacy-skills` and any `…@processing-llm` entries; base gets `pr-review-toolkit@…`, `commit-commands@…`, `ralph-loop@…`, `feature-dev@…`, `claude-permission-audit@daniel-tools`.
- `extraKnownMarketplaces`: overlay gets `processing-llm` and `privacy-skills`; base gets `daniel-tools` (and any other non-work marketplaces).
- `hooks`: overlay gets the entry whose command is `~/.claude/hooks/redact-pan.sh`; base gets every other hook (auto-format, lint, protect-secrets, log-permission, etc.).
- `permissions`, `sandbox`, `env`: split entry-by-entry — anything Lithic/work-pathed → overlay; the rest → base. Arrays (deny/allow lists) split element-wise.
- Top-level scalars (`model`, `theme`, `statusLine`, etc.): base, unless work-specific.

Write the base keys to `home/.chezmoitemplates/settings.base.json` and the work-only keys to `~/work-laptop-config/.config/claude/settings.work.json`. Both must be valid standalone JSON objects.

- [ ] **Step 3: Verify the merge reproduces the current file (semantic equality)**

```bash
node ~/.local/share/chezmoi/home/dot_local/bin/executable_claude-settings-merge \
  ~/.local/share/chezmoi/home/.chezmoitemplates/settings.base.json \
  ~/work-laptop-config/.config/claude/settings.work.json > /tmp/settings.merged.json

# Semantic (order-insensitive) diff via sorted keys:
node -e 'const fs=require("node:fs");const s=p=>JSON.stringify(JSON.parse(fs.readFileSync(p,"utf8")),Object.keys(JSON.parse(fs.readFileSync(p,"utf8"))).sort?undefined:undefined,2);' 2>/dev/null || true
node -e '
const fs=require("node:fs");
const norm=o=>Array.isArray(o)?o.map(norm):(o&&typeof o==="object"?Object.fromEntries(Object.keys(o).sort().map(k=>[k,norm(o[k])])):o);
const a=norm(JSON.parse(fs.readFileSync("/tmp/settings.current.json","utf8")));
const b=norm(JSON.parse(fs.readFileSync("/tmp/settings.merged.json","utf8")));
const A=JSON.stringify(a),B=JSON.stringify(b);
if(A===B){console.log("REPRODUCES current settings.json ✓");}else{console.log("MISMATCH — adjust classification");process.exit(1);}
'
```
Expected: `REPRODUCES current settings.json ✓`. If `MISMATCH`, adjust which keys are base vs overlay and re-run (arrays may need the missing element moved). Do not proceed until it reproduces.

- [ ] **Step 4: Commit (work repo overlay)**

```bash
cd ~/work-laptop-config
git add .config/claude/settings.work.json
git commit -m "feat(settings): add work overlay (Lithic plugins, marketplaces, redact-pan wiring)"
```

(The base fragment is committed in Task 4 alongside the modify script.)

---

### Task 4: Wire `settings.json` generation (templated modify script)

**Files:**
- Create: `home/.chezmoitemplates/settings.base.json` is already created (Task 3) — committed here.
- Rewrite: `home/private_dot_claude/modify_settings.json`

**Interfaces:**
- Consumes: `settings.base.json` (via `includeTemplate`), the work overlay at `~/.config/claude/settings.work.json` (symlinked by the work repo; absent on personal machines), and `claude-settings-merge` from the chezmoi source dir.
- Produces: `~/.claude/settings.json` = `merge(base, overlay-if-present)` on every machine.

- [ ] **Step 1: Replace the modify script with the base+overlay merge**

Overwrite `home/private_dot_claude/modify_settings.json` (it becomes a chezmoi template; chezmoi processes `modify_` scripts as templates automatically):

```sh
#!/bin/sh
# chezmoi modify_ script (templated): regenerate ~/.claude/settings.json as
#   merge(general base, work overlay-if-present).
# stdin (current target content) is intentionally ignored — the file is fully derived.
set -eu

BASE="$(mktemp)"
trap 'rm -f "$BASE"' EXIT
cat > "$BASE" <<'CHEZMOI_BASE_EOF'
{{ includeTemplate "settings.base.json" }}
CHEZMOI_BASE_EOF

OVERLAY="$HOME/.config/claude/settings.work.json"   # absent on non-work machines

node "{{ .chezmoi.sourceDir }}/dot_local/bin/executable_claude-settings-merge" "$BASE" "$OVERLAY"
```

Why source-dir path for the helper: it is guaranteed present during `apply` regardless of target apply-order; `{{ .chezmoi.sourceDir }}` resolves in the template.

- [ ] **Step 2: Verify the rendered modify output matches the current file**

```bash
cd ~/.local/share/chezmoi
# With the overlay present on disk (it is, once Task 2/3 symlink or file exists), preview:
chezmoi cat ~/.claude/settings.json > /tmp/settings.rendered.json
node -e '
const fs=require("node:fs");
const norm=o=>Array.isArray(o)?o.map(norm):(o&&typeof o==="object"?Object.fromEntries(Object.keys(o).sort().map(k=>[k,norm(o[k])])):o);
const a=JSON.stringify(norm(JSON.parse(fs.readFileSync("/tmp/settings.current.json","utf8"))));
const b=JSON.stringify(norm(JSON.parse(fs.readFileSync("/tmp/settings.rendered.json","utf8"))));
console.log(a===b?"RENDER MATCHES current ✓":"MISMATCH"); if(a!==b) process.exit(1);
'
```
Note: at this point the overlay file must be readable at `~/.config/claude/settings.work.json`. If the work repo's `install.sh` has not run yet, temporarily copy it: `mkdir -p ~/.config/claude && cp ~/work-laptop-config/.config/claude/settings.work.json ~/.config/claude/` (the real symlink is created during cutover, Task 9).
Expected: `RENDER MATCHES current ✓`.

- [ ] **Step 3: Commit (general repo)**

```bash
cd ~/.local/share/chezmoi
git add home/.chezmoitemplates/settings.base.json home/private_dot_claude/modify_settings.json
git commit -m "feat(settings): generate settings.json from general base + work overlay merge"
```

---

### Task 5: Shell — extract work blocks to `local.zsh`, add the extension point

**Files:**
- Create: `~/work-laptop-config/.config/zsh/local.zsh`
- Modify: `home/dot_zshrc.tmpl`, `home/dot_zprofile.tmpl`, `home/dot_bash_profile.tmpl`

**Interfaces:**
- Produces: a work-agnostic `.zshrc` that sources `~/.config/zsh/local.zsh` if present; `local.zsh` holds all work shell content.

- [ ] **Step 1: Move the `{{ if .work }}` blocks verbatim into `local.zsh`**

In `home/dot_zshrc.tmpl`, locate each `{{ if .work }} … {{ end }}` block (GRAFANA_URL export; the AWS/SSO section incl. `aws_completer`; the `vault` alias; the 1Password CLI section `_op_load_keys`/`op-refresh-keys`/`_op_lazy_precmd`/`add-zsh-hook precmd`/`SSH_AUTH_SOCK`). Cut their **inner content** (not the `{{ if }}` wrapper) and paste, in original order, into `~/work-laptop-config/.config/zsh/local.zsh`. Also move the Snowflake PATH line out of `home/dot_zprofile.tmpl` and `home/dot_bash_profile.tmpl` into `local.zsh`. Prepend `local.zsh` with a comment header noting it is work-only and machine-local.

- [ ] **Step 2: Remove the now-empty `{{ if .work }}` wrappers and add the extension point**

In `home/dot_zshrc.tmpl`, delete the emptied `{{ if .work }}…{{ end }}` wrappers, and add near the very end (after plugins/syntax-highlighting):

```zsh
# Machine-local shell config (provided per-machine; absent on portable machines)
[[ -r "$HOME/.config/zsh/local.zsh" ]] && source "$HOME/.config/zsh/local.zsh"
```

In `home/dot_zprofile.tmpl` and `home/dot_bash_profile.tmpl`, delete the Snowflake block (now in `local.zsh`).

- [ ] **Step 3: Verify the rendered general `.zshrc` is clean and valid**

```bash
cd ~/.local/share/chezmoi
chezmoi cat ~/.zshrc > /tmp/zshrc.rendered
grep -nE 'GRAFANA_URL|aws_completer|op://|SnowflakeCLI|_op_load|vault=' /tmp/zshrc.rendered && echo "LEAK — work content remains" || echo "CLEAN ✓"
zsh -n /tmp/zshrc.rendered && echo "SYNTAX OK ✓"
# local.zsh must carry the moved content + be valid:
zsh -n ~/work-laptop-config/.config/zsh/local.zsh && echo "local.zsh SYNTAX OK ✓"
```
Expected: `CLEAN ✓`, `SYNTAX OK ✓`, `local.zsh SYNTAX OK ✓`.

- [ ] **Step 4: Commit both repos**

```bash
cd ~/work-laptop-config && git add .config/zsh/local.zsh && git commit -m "feat(shell): add work-only local.zsh (AWS/Snowflake/1Password/Grafana)"
cd ~/.local/share/chezmoi && git add home/dot_zshrc.tmpl home/dot_zprofile.tmpl home/dot_bash_profile.tmpl && git commit -m "refactor(shell): move work blocks to local.zsh; source local.zsh if present"
```

---

### Task 6: CLAUDE.md — extract work section + docs, add optional import

**Files:**
- Create: `~/work-laptop-config/.claude/CLAUDE.local.md`, `.claude/docs/integrations.md`, `.claude/docs/enforcement.md`
- Modify: `home/private_dot_claude/CLAUDE.md.tmpl`

**Interfaces:**
- Produces: a general `CLAUDE.md` with no Lithic content that optionally imports `~/.claude/CLAUDE.local.md`; the work repo carries the Lithic section + its doc imports.

- [ ] **Step 1: Verify Claude Code tolerates a missing `@import`**

```bash
mkdir -p /tmp/cmtest && printf '# Test\n@~/.claude/DOES-NOT-EXIST.md\nhello\n' > /tmp/cmtest/CLAUDE.md
```
Open a throwaway `claude` session in `/tmp/cmtest` and confirm it loads without error (or check current docs via the claude-code-guide agent). **If a missing import errors/noises:** use the fallback — omit the import from the general `CLAUDE.md`, and have the work repo's `install.sh` instead write `~/.claude/CLAUDE.md` by concatenating the general baseline + the work section. Record which path was taken.

- [ ] **Step 2: Move the work content out**

From `home/private_dot_claude/CLAUDE.md.tmpl`, cut the `{{ if .work }}` "About me", "Environment", "Model routing", "Domain context" blocks and the `@~/.claude/docs/integrations.md` / `@~/.claude/docs/enforcement.md` imports into `~/work-laptop-config/.claude/CLAUDE.local.md` (drop the `{{ if .work }}` wrappers; keep the doc imports). Move the existing on-disk `~/.claude/docs/integrations.md` and `~/.claude/docs/enforcement.md` into `~/work-laptop-config/.claude/docs/`.

- [ ] **Step 3: Trim the general template + add the optional import**

In `home/private_dot_claude/CLAUDE.md.tmpl`: remove the emptied `{{ if .work }}` blocks (the darwin-gated signing line stays). At the end add:

```markdown

@~/.claude/CLAUDE.local.md
```

- [ ] **Step 4: Verify the general render is Lithic-free**

```bash
cd ~/.local/share/chezmoi
chezmoi cat ~/.claude/CLAUDE.md > /tmp/claude.rendered
grep -nE 'Lithic|PCI-DSS|planner|Processing team|integrations.md|enforcement.md' /tmp/claude.rendered && echo "LEAK" || echo "CLEAN ✓"
```
Expected: `CLEAN ✓`.

- [ ] **Step 5: Commit both repos**

```bash
cd ~/work-laptop-config && git add .claude/CLAUDE.local.md .claude/docs && git commit -m "feat(claude): add work CLAUDE.local.md + integrations/enforcement docs"
cd ~/.local/share/chezmoi && git add home/private_dot_claude/CLAUDE.md.tmpl && git commit -m "refactor(claude): drop Lithic blocks; optionally import CLAUDE.local.md"
```

---

### Task 7: gitconfig — replace work name with `[include]`

**Files:**
- Create: `~/work-laptop-config/.config/git/local.config`
- Modify: `home/dot_gitconfig.tmpl`

- [ ] **Step 1: Add the work identity to the work repo**

Create `~/work-laptop-config/.config/git/local.config`:

```ini
[user]
	name = Daniel Hunter
```

- [ ] **Step 2: Replace the `{{ if .work }}` name with an include**

In `home/dot_gitconfig.tmpl`, change the `[user] name` line so it no longer branches on `.work` (use the personal default `DanielH2018`), and add at the end of the file:

```ini
[include]
	path = ~/.config/git/local.config
```

(`git` silently ignores a missing include path, so this is inert on personal machines.)

- [ ] **Step 3: Verify**

```bash
cd ~/.local/share/chezmoi
chezmoi cat ~/.gitconfig > /tmp/gc.rendered
git config -f /tmp/gc.rendered --list >/dev/null && echo "VALID ✓"
grep -q 'path = ~/.config/git/local.config' /tmp/gc.rendered && echo "INCLUDE PRESENT ✓"
```
Expected: `VALID ✓`, `INCLUDE PRESENT ✓`.

- [ ] **Step 4: Commit both repos**

```bash
cd ~/work-laptop-config && git add .config/git/local.config && git commit -m "feat(git): add work identity override (user.name)"
cd ~/.local/share/chezmoi && git add home/dot_gitconfig.tmpl && git commit -m "refactor(git): replace work-name branch with optional [include]"
```

---

### Task 8: Move `redact-pan.sh` to the work repo; ship the manifest fragment

**Files:**
- Delete: `home/private_dot_claude/hooks/executable_redact-pan.sh` (general repo)
- Create: `~/work-laptop-config/.claude/hooks/redact-pan.sh`, `~/work-laptop-config/.config/dotsync/manifest.d/50-work.json`

- [ ] **Step 1: Move the hook**

```bash
cp ~/.claude/hooks/redact-pan.sh ~/work-laptop-config/.claude/hooks/redact-pan.sh
chmod +x ~/work-laptop-config/.claude/hooks/redact-pan.sh
git -C ~/.local/share/chezmoi rm home/private_dot_claude/hooks/executable_redact-pan.sh
```
Confirm `protect-secrets.sh` and all other hooks remain under `home/private_dot_claude/hooks/`.

- [ ] **Step 2: Add the work manifest fragment (for Plan 2's `dotsync`)**

Create `~/work-laptop-config/.config/dotsync/manifest.d/50-work.json`:

```json
{
  "repo": {
    "name": "work",
    "type": "git-symlink",
    "path": "~/work-laptop-config",
    "remote": "git@github.com:DanielH2018/work-laptop-config.git"
  }
}
```

Update `install.sh`'s `ROOTS` to drop the standalone `manifest.d` (the fragment now lives under `.config/dotsync/manifest.d/` and is covered by the `.config` root). Re-run `~/work-laptop-config/test-install.sh` → `ALL PASS`.

- [ ] **Step 3: Commit both repos**

```bash
cd ~/work-laptop-config && git add .claude/hooks/redact-pan.sh .config/dotsync/manifest.d/50-work.json install.sh && git commit -m "feat: own redact-pan hook + dotsync work manifest fragment"
cd ~/.local/share/chezmoi && git commit -m "refactor(hooks): remove work-only redact-pan (moves to work repo)"
```

---

### Task 9: Cutover + verification

**Files:** none new — this applies everything and proves behavior preservation.

- [ ] **Step 1: Back up**

```bash
ts=$(date +%Y%m%d-%H%M%S)
tar -czf ~/dotfiles-pre-split-$ts.tar.gz -C ~ .claude .zshrc .zshenv .zprofile .bash_profile .gitconfig .config/git 2>/dev/null
ls -lh ~/dotfiles-pre-split-$ts.tar.gz
```

- [ ] **Step 2: Deploy the work repo (symlinks)**

```bash
~/work-laptop-config/install.sh
ls -l ~/.config/claude/settings.work.json ~/.config/zsh/local.zsh ~/.claude/hooks/redact-pan.sh ~/.claude/CLAUDE.local.md ~/.config/git/local.config
```
Expected: each is a symlink into `~/work-laptop-config`.

- [ ] **Step 3: Apply chezmoi + prove settings.json is reproduced**

```bash
cd ~
chezmoi apply -v
node -e '
const fs=require("node:fs");
const norm=o=>Array.isArray(o)?o.map(norm):(o&&typeof o==="object"?Object.fromEntries(Object.keys(o).sort().map(k=>[k,norm(o[k])])):o);
const a=JSON.stringify(norm(JSON.parse(fs.readFileSync("/tmp/settings.current.json","utf8"))));
const b=JSON.stringify(norm(JSON.parse(fs.readFileSync(process.env.HOME+"/.claude/settings.json","utf8"))));
console.log(a===b?"settings.json REPRODUCED ✓":"MISMATCH"); if(a!==b) process.exit(1);
'
chezmoi diff --no-pager | head -40   # expect empty / no content changes
```
Expected: `settings.json REPRODUCED ✓`; `chezmoi diff` clean.

- [ ] **Step 4: Behavior checks**

```bash
zsh -ic 'echo SHELL_OK' 2>/tmp/zsh.err; grep -iE 'no such file|parse error|command not found' /tmp/zsh.err && echo "SHELL ERRORS" || echo "SHELL CLEAN ✓"
git config --get user.name           # expect: Daniel Hunter (via include)
git config --get user.email          # expect: danielh.2018@gmail.com
[ -x ~/.claude/hooks/redact-pan.sh ] && echo "redact-pan present+exec ✓"
```
Expected: `SHELL CLEAN ✓`, `Daniel Hunter`, exec hook present.

- [ ] **Step 5: Push both repos**

```bash
# Create the empty private GitHub repo DanielH2018/work-laptop-config first (gh or web UI).
cd ~/work-laptop-config && git remote add origin git@github.com:DanielH2018/work-laptop-config.git && git push -u origin main
cd ~/.local/share/chezmoi && git push origin main
```

- [ ] **Step 6: Update the project memory**

Update `~/.claude/projects/-Users-daniel/memory/project_dotfiles_repo.md` (and the MEMORY.md index line) to record the two-repo split: general repo work-agnostic; `work-laptop-config` (private, symlink-deployed via `install.sh`) holds work config; `settings.json` is generated by base⊕overlay merge. Link `[[project_claude_setup_review]]`.

---

## Self-Review

**1. Spec coverage:**
- Two repos, decoupled, work-agnostic general repo → Tasks 5–8 (extension points) + Task 9. ✓
- Symlink-farm deployment (Approach A) → Task 2. ✓
- `protect-secrets` stays, only `redact-pan` moves → Task 8. ✓
- settings.json base+overlay deep-merge (objects/arrays/scalar semantics) → Tasks 1, 3, 4. ✓
- No-plaintext-secrets / private repo → Global Constraints + Task 9 Step 5. ✓
- Resolves general-hook-wiring (base carries it) → Task 3 (base includes general hooks). ✓
- Behavior-preserving cutover (reproduce current settings.json, clean diff) → Tasks 3/4/9. ✓
- `dotsync` manifest fragment prepared → Task 8 (full `dotsync` = Plan 2). ✓
- Backup before cutover → Task 9 Step 1. ✓

**2. Placeholder scan:** No TBD/TODO. Content-extraction tasks (3, 5, 6) give exact classification rules + a verifiable acceptance test (semantic-equality to the current file) rather than guessed literals, because the exact bytes must be read from the live machine; this is a deterministic procedure with a pass/fail gate, not a placeholder. ✓

**3. Type consistency:** `claude-settings-merge` CLI signature (positional JSON file args, missing files skipped) is used identically in Tasks 1, 3, 4. Overlay path `~/.config/claude/settings.work.json` and base template name `settings.base.json` match across Tasks 3, 4, 9. Work repo paths match Task 2's `install.sh` roots after the Task 8 adjustment. ✓

## Execution Handoff

(See end of conversation for execution-mode choice.)
