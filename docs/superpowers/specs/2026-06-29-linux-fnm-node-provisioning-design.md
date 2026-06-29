# Linux fnm + node provisioning (chezmoi) — design

- **Date:** 2026-06-29
- **Status:** Approved (design); pending spec review
- **Scope:** dotfiles repo (`home/` chezmoi source) — one new script, one probe edit, one test

## Problem

The chezmoi `modify_settings.json.tmpl` script regenerates `~/.claude/settings.json` by
shelling out to **node** (via `dot_local/bin/executable_claude-settings-merge`). On macOS,
node's manager **fnm** is installed by the `Brewfile` (`brew "fnm"`) and the shell rc files
activate it (`eval "$(fnm env …)"` in `dot_zshrc.tmpl` / `dot_bash_profile.tmpl`).

On Linux there is **no** fnm install hook. A fresh Linux machine therefore has no node that
chezmoi can find, and `chezmoi apply` (which runs the `modify_` script) fails:

```
modify_settings: node not found on PATH or common locations; cannot generate ~/.claude/settings.json
```

Secondly, the script's existing fnm fallback probes `~/.local/state/fnm_multishells/*/bin/node`
— a path that only exists inside a shell that has already evaluated `fnm env`. During a
headless `chezmoi apply` (not launched from an fnm-activated shell) it never matches, so even
*with* fnm installed the merge can fail.

## Goals

- Provision fnm + a default LTS node on Linux automatically, in-repo (no manual `curl | bash`),
  mirroring the macOS `Brewfile` path. Repeatable and portable across Linux machines.
- Make node discoverable by `modify_settings` during a **headless** apply.

## Non-goals

- Windows fnm provisioning (handled separately by the repo's Windows support).
- Removing/altering an existing nvm install. nvm may coexist; the merge prefers PATH node,
  then fnm's default — it does not depend on nvm.
- Pinning an exact node version. Policy is "latest LTS, auto" (chosen during brainstorming).

## Design

### Change 1 — `home/run_once_before_install-fnm.sh.tmpl` (new)

A chezmoi `run_once_before_` script. `run_once_` runs on first apply and re-runs only when the
script's content hash changes (bump an embedded comment to force a refresh). `_before_`
guarantees it runs before file targets, so node exists before `modify_settings` evaluates.

- **OS gate:** `{{ if ne .chezmoi.os "windows" }} … {{ end }}` (portable across macOS + Linux;
  empty render on Windows → chezmoi skips it).
- **Install fnm binary if missing** (`! command -v fnm && ! -x ~/.local/bin/fnm`):
  - **Only on Linux** (`[ "$(uname -s)" = Linux ]`) — a brew-managed mac is left untouched.
  - Arch-detect the release asset from `uname -m`:
    `x86_64|amd64 → fnm-linux`, `aarch64|arm64 → fnm-arm64`, `armv7l → fnm-arm32`
    (covers daniel-server x86_64 and the Pi). Unknown arch → clear error + exit 1.
  - Download `https://github.com/Schniz/fnm/releases/latest/download/<asset>.zip` to a temp
    dir, `unzip`, `install -m 0755` the `fnm` binary to `~/.local/bin/fnm`
    (`~/.local/bin` is already on PATH via `dot_zshrc.tmpl`).
- **Ensure a default node** (any non-Windows OS, runs once fnm is present):
  - If `${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default` is absent:
    `fnm install --lts && fnm default lts-latest`. Idempotent.
  - This step also runs on macOS, so a fresh mac with brew-fnm but no node gets one.

**Rationale for direct-binary download over the official installer:** the official
`curl … | bash` installer's primary side effect is editing shell rc files — which chezmoi
already owns. Downloading just the binary is more transparent, avoids piping a remote script
to a shell, and lands directly on the existing PATH.

### Change 2 — `home/private_dot_claude/modify_settings.json.tmpl` (edit)

Harden the node probe. Keep `command -v node` first (an fnm-activated interactive shell already
has it). Then, before the homebrew/`/usr/local` fallbacks, add fnm's **default-alias** path —
deterministic and respecting `fnm default`:

```sh
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for c in \
    "${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    /opt/homebrew/bin/node /usr/local/bin/node \
    "$HOME"/.local/state/fnm_multishells/*/bin/node; do
    [ -x "$c" ] && NODE="$c" && break
  done
fi
```

The new alias paths are what make a headless apply succeed; the existing entries are retained
as fallbacks.

### Change 3 — `tests/modify_settings.test.js` (extend)

Add a case proving the fnm fallback works when node is **not** on PATH:

- Render the template with `chezmoi execute-template` (as the existing test does).
- Run the rendered script with `PATH` stripped of node, `HOME`/`FNM_DIR` pointed at a temp dir
  containing a shim at `$FNM_DIR/aliases/default/bin/node` (a wrapper that execs the real node).
- Assert the output is valid JSON carrying the base `permissions` object.

The existing assertions continue to cover the node-on-PATH path. The installer script is
validated by the real `chezmoi apply` on daniel-server (integration), not a unit test
(network + binary download are out of scope for the node test suite).

## Rollout

1. Implement Changes 1–3.
2. Run the repo's node test suite; confirm green.
3. `chezmoi apply` on daniel-server: the `run_once_before` script installs fnm + LTS node,
   then the 23 pending home-dir changes land (settings.json merge now resolves node).
4. Verify: `fnm --version`, `fnm default` node present, `chezmoi status` empty, settings.json
   contains the merged base.

## Risks / notes

- **`fnm default lts-latest` alias:** verify fnm accepts `lts-latest` as a version spec in the
  target fnm version; if not, capture the installed version from `fnm install --lts` output and
  pass that to `fnm default`.
- **macOS behavior change:** the ensure-default-node step now also runs on macOS. It is
  idempotent and only acts when no default alias exists, but it is a (small) new behavior on a
  fresh mac. Accepted (chosen "portable / non-Windows" scope).
- **nvm coexistence:** this server currently has nvm. It is left in place; the merge no longer
  depends on it.
