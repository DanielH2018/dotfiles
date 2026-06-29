# Linux fnm + node provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision fnm + a default LTS node on Linux from the dotfiles repo, and make node discoverable during a headless `chezmoi apply`, so the `modify_settings.json` merge works on a fresh machine.

**Architecture:** A `run_once_before_` chezmoi script installs the fnm release binary (Linux, arch-detected) into `~/.local/bin` and ensures a default LTS node; the `modify_settings.json.tmpl` node probe gains fnm's deterministic default-alias path so apply succeeds without an fnm-activated shell.

**Tech Stack:** chezmoi (templated scripts), POSIX `/bin/sh`, fnm, node, node's built-in test runner (`node --test`).

## Global Constraints

- chezmoi source root is `home/` (`.chezmoiroot`). All target files live under `home/`.
- Scripts are POSIX `/bin/sh` (not bash). `set -eu`.
- OS gating via chezmoi templating: `{{ if ne .chezmoi.os "windows" }} … {{ end }}` (empty render → chezmoi skips).
- fnm binary install is **Linux-only** (`uname -s = Linux`); the ensure-default-node step runs on any non-Windows OS.
- node version policy: **latest LTS, auto** (`fnm install --lts` + `fnm default lts-latest`).
- `~/.local/bin` is already on PATH via `dot_zshrc.tmpl`; install fnm there.
- Tests live in `tests/` and run under `node --test`.

---

### Task 1: Harden the node probe in modify_settings (TDD)

**Files:**
- Modify: `home/private_dot_claude/modify_settings.json.tmpl` (the `for c in …` probe loop)
- Test: `tests/modify_settings.test.js` (append a case)

**Interfaces:**
- Consumes: existing rendered script behavior (renders via `chezmoi execute-template`, exec'd as `/bin/sh`, output is fully-derived merged JSON; stdin ignored).
- Produces: same script, now resolving node from `${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node` (and `~/.fnm/...`) when node is not on PATH.

- [ ] **Step 1: Write the failing test** — append to `tests/modify_settings.test.js`:

```javascript
// 3. fnm fallback: with node NOT on PATH but an fnm default-alias node present,
//    the script resolves it (headless-apply path) and still emits valid merged JSON.
const fnmHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fnmhome-'));
const fnmDefaultBin = path.join(fnmHome, '.local', 'share', 'fnm', 'aliases', 'default', 'bin');
fs.mkdirSync(fnmDefaultBin, { recursive: true });
fs.writeFileSync(
  path.join(fnmDefaultBin, 'node'),
  `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 },
);
// Minimal PATH: the coreutils the script needs, but deliberately no `node`.
const toolbin = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbin-'));
for (const tool of ['cat', 'mktemp', 'rm']) {
  const p = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
  if (p) fs.symlinkSync(p, path.join(toolbin, tool));
}
const outFnm = execFileSync(script, [], {
  input: '',
  encoding: 'utf8',
  env: { HOME: fnmHome, PATH: toolbin },
});
assert.ok(JSON.parse(outFnm).permissions, 'fnm-fallback output carries the base permissions');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/.local/share/chezmoi && node --test tests/modify_settings.test.js`
Expected: FAIL — with the current probe (no fnm default-alias path), `command -v node` returns empty under the scrubbed PATH and no fallback matches, so the script exits 1 ("node not found") and `execFileSync` throws.

- [ ] **Step 3: Make the change** — in `home/private_dot_claude/modify_settings.json.tmpl`, replace the probe loop.

Old:
```sh
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.local/state/fnm_multishells/*/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
```
New:
```sh
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  # fnm's default alias resolves a node without an interactive `fnm env`, so this
  # works during a headless `chezmoi apply`. multishells/* only exists inside an
  # fnm-activated shell and is kept as a last-resort fallback.
  for c in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node \
    "$HOME"/.local/state/fnm_multishells/*/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.local/share/chezmoi && node --test tests/modify_settings.test.js`
Expected: PASS — all cases (on-PATH, stdin-ignored, fnm-fallback) green.

- [ ] **Step 5: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/private_dot_claude/modify_settings.json.tmpl tests/modify_settings.test.js
git commit -m "fix(chezmoi): resolve node via fnm default alias for headless apply

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add the fnm installer script

**Files:**
- Create: `home/run_once_before_install-fnm.sh.tmpl`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `~/.local/bin/fnm` (Linux) and a default LTS node at `${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default` — the exact path Task 1's probe reads.

- [ ] **Step 1: Create the script** — `home/run_once_before_install-fnm.sh.tmpl`:

```sh
{{ if ne .chezmoi.os "windows" -}}
#!/bin/sh
# Installs fnm (Fast Node Manager) + a default LTS node, mirroring the macOS Brewfile's
# `brew "fnm"` so a fresh Linux machine has node for the modify_settings.json merge and
# other node tooling. run_once_before_: runs before file targets and only re-runs when
# this script's contents change. Bump the marker below to force a refresh.
# fnm-bump: v1
set -eu

BIN_DIR="$HOME/.local/bin"                       # already on PATH via dot_zshrc.tmpl
FNM_DIR="${FNM_DIR:-$HOME/.local/share/fnm}"

# 1. Install the fnm binary if missing — Linux only (macOS gets it from the Brewfile).
if ! command -v fnm >/dev/null 2>&1 && [ ! -x "$BIN_DIR/fnm" ] && [ "$(uname -s)" = "Linux" ]; then
  case "$(uname -m)" in
    x86_64|amd64)  asset="fnm-linux" ;;
    aarch64|arm64) asset="fnm-arm64" ;;
    armv7l)        asset="fnm-arm32" ;;
    *) echo "install-fnm: unsupported arch $(uname -m); install fnm manually" >&2; exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/Schniz/fnm/releases/latest/download/${asset}.zip"
  echo "install-fnm: downloading $asset …" >&2
  curl -fsSL "$url" -o "$tmp/fnm.zip"
  unzip -q "$tmp/fnm.zip" -d "$tmp"
  mkdir -p "$BIN_DIR"
  install -m 0755 "$tmp/fnm" "$BIN_DIR/fnm"
fi

# 2. Ensure a default LTS node exists (idempotent; any non-Windows OS).
FNM="$(command -v fnm 2>/dev/null || echo "$BIN_DIR/fnm")"
if [ -x "$FNM" ] || command -v fnm >/dev/null 2>&1; then
  if [ ! -e "$FNM_DIR/aliases/default" ]; then
    echo "install-fnm: installing latest LTS node …" >&2
    "$FNM" install --lts
    "$FNM" default lts-latest
  fi
fi
{{ end -}}
```

- [ ] **Step 2: Verify it renders (non-empty on this Linux host)**

Run: `cd ~/.local/share/chezmoi && chezmoi execute-template < home/run_once_before_install-fnm.sh.tmpl | head -5`
Expected: prints the `#!/bin/sh` header and comments (proves the `ne windows` gate renders the body on Linux).

- [ ] **Step 3: Shellcheck the rendered script**

Run: `cd ~/.local/share/chezmoi && chezmoi execute-template < home/run_once_before_install-fnm.sh.tmpl | shellcheck -s sh - || true`
Expected: no errors (warnings about dynamic paths acceptable). If `shellcheck` is absent, skip.

- [ ] **Step 4: Commit**

```bash
cd ~/.local/share/chezmoi
git add home/run_once_before_install-fnm.sh.tmpl
git commit -m "feat(chezmoi): install fnm + default LTS node on Linux

Mirrors the macOS Brewfile so a fresh Linux machine provisions node for
the modify_settings merge automatically. Linux-only binary download;
ensure-default-node runs on any non-Windows OS.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Apply on daniel-server + verify, open PR

**Files:** none (operational).

- [ ] **Step 1: Apply** — `chezmoi apply` runs the run_once installer (fnm + LTS node) then lands the 23 pending home-dir changes.

Run: `cd ~ && chezmoi apply 2>&1 | tail -20`
Expected: no "node not found" error; exit 0.

- [ ] **Step 2: Verify node + fnm**

Run: `~/.local/bin/fnm --version && ls "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node"`
Expected: fnm version prints; the default node symlink exists.

- [ ] **Step 3: Verify chezmoi in sync + settings merged**

Run: `chezmoi status; node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json"))' && echo "settings.json valid"`
Expected: `chezmoi status` empty; settings.json parses.

- [ ] **Step 4: Push branch + open PR**

```bash
cd ~/.local/share/chezmoi
git push -u origin feat/linux-fnm-node
gh pr create --fill --base main
```

- [ ] **Step 5: After merge** — switch local source back to main and fast-forward.

```bash
cd ~/.local/share/chezmoi && git checkout main && git pull --ff-only origin main
```
