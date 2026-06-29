# Codified Linux shell-tool installer (daniel-server) — design

- **Date:** 2026-06-29
- **Status:** Approved (design); pending spec review
- **Scope:** dotfiles repo — one new `run_once` installer + one `dot_zshrc.tmpl` guard fix

## Problem

The dotfiles' intended CLI toolset is defined by the macOS `Brewfile`, but there is **no Linux
install mechanism** — the `Brewfile` is darwin-only (excluded on Linux via `.chezmoiignore`). So on
daniel-server many tools the shell config expects are absent. They mostly degrade silently (guarded
by `command -v`), but the experience is reduced (plain `ls` instead of `eza`, no fd/bat/btop, no zsh
autosuggestions/highlighting), and **`fastfetch` actually errors on every login shell** due to a
guard bug.

Installed already: bash, chezmoi, fnm, fzf, gh, ripgrep, starship, tmux, wget, zoxide, vim.
Missing (this design's target): eza, bat, fd, btop, chafa, curlie, sd, fastfetch,
zsh-autosuggestions, zsh-syntax-highlighting.

## Goals

- Codify installation of the **shell-experience** CLI tools on **daniel-server** (Ubuntu noble,
  amd64), repeatably and idempotently — no manual installs.
- Fix the `fastfetch` login-banner guard so it stops erroring when the binary is absent.

## Non-goals

- Dev tooling (pipx, pre-commit, taplo, corepack, pulumi) — out of scope (chosen).
- The Pi (Zero 2 W, 512 MB) — gated out; cargo/heavy installs are unsafe there. May get an
  apt-only subset later.
- macOS — unaffected (keeps the `Brewfile`).

## Decisions (from brainstorming)

- **Mechanism:** apt for what's in Ubuntu repos + targeted supplements (prebuilt release binaries)
  for the gaps. (Not Homebrew-on-Linux — too heavy; not all-binary — apt is cleaner where available.)
- **Tools:** shell-experience set only.
- **Hosts:** daniel-server only (`.chezmoi.hostname == "daniel-server"`, verified).

## Design

### Change 1 — `home/dot_zshrc.tmpl` (guard fix)

`dot_zshrc.tmpl:231` defines a `fastfetch()` wrapper function; the login banner guard at line 244
uses `command -v fastfetch`, which matches that **function** and is therefore always true — so on a
host without the binary the banner runs the function, which calls `command fastfetch` and prints
`fastfetch:6: command not found`. Fix the guard to test for an external command:

```sh
# before
if [[ -o login ]] && command -v fastfetch >/dev/null 2>&1; then
# after
if [[ -o login ]] && (( $+commands[fastfetch] )); then
```

`$+commands[name]` is zsh's external-command table (excludes functions/aliases), so the banner runs
only when the fastfetch **binary** exists. No other behavior changes.

### Change 2 — `home/run_once_before_install-cli-tools.sh.tmpl` (new)

A chezmoi `run_once_before_` script (runs once per content hash). Gated:

```
{{ if and (eq .chezmoi.os "linux") (eq .chezmoi.hostname "daniel-server") -}}
```

renders empty elsewhere → chezmoi skips it on the Pi, macOS, Windows.

Script behavior (`#!/bin/sh`, `set -u`; **not** `set -e` over the whole body, so one tool's failure
does not abort the rest; every step idempotent):

1. **apt block** — packages present in Ubuntu noble: `btop chafa bat fd-find
   zsh-autosuggestions zsh-syntax-highlighting`. Build a list of the missing ones (via `command -v`
   / `dpkg -s`); if non-empty, `sudo apt-get update` then `sudo apt-get install -y <missing>`. If
   `sudo` is unavailable/non-interactive, print a warning and continue (binary tools still install).
   - The two zsh plugins install to `/usr/share/zsh-autosuggestions/` and
     `/usr/share/zsh-syntax-highlighting/`, which `dot_zshrc.tmpl:260/267` already source.

2. **name symlinks** in `~/.local/bin` (already on PATH): `bat → $(command -v batcat)`,
   `fd → $(command -v fdfind)` (Ubuntu ships these under renamed binaries). `ln -sf`, only if the
   target binary exists and the link isn't already correct. This means the shell uses the real
   `bat`/`fd` names — **no zshrc alias changes needed**.

3. **binary downloads** to `~/.local/bin` (no sudo), each skipped if already on PATH — the apt gaps:
   - `eza`  — `eza-community/eza` release `eza_<arch>-unknown-linux-gnu.tar.gz`
   - `sd`   — `chmln/sd` release `sd-<ver>-<arch>-unknown-linux-gnu.tar.gz`
   - `curlie`— `rs/curlie` release `curlie_<ver>_linux_amd64.tar.gz`
   - `fastfetch` — `fastfetch-cli/fastfetch` release `fastfetch-linux-<arch>.tar.gz`
   - Arch-detected from `uname -m` (amd64/x86_64 on this host); latest release; a `# bump:` marker
     comment forces a refresh when changed — same pattern as `run_once_before_install-fnm.sh.tmpl`.
   - Exact asset names/extraction paths are verified during implementation (release layouts differ
     per project); install the extracted binary with `install -m 0755` into `~/.local/bin`.

### Why not touch the shell aliases

`dot_zshrc.tmpl` already gates `eza`/`fd` usage behind `command -v`, and the bat/fd symlinks give
the real names, so once the tools exist the existing config picks them up. The only shell change is
the fastfetch guard fix (Change 1).

## Rollout

1. Implement Changes 1–2 on `feat/linux-cli-tools`.
2. Render + `sh -n` the installer; run the node test suite (unaffected; sanity).
3. `chezmoi apply` on daniel-server (prompts for sudo for the apt block); installs the toolset.
4. Verify: all 10 tools resolve on PATH; a fresh login zsh is error-free; `bat`/`fd`/`eza` work;
   autosuggestions + syntax-highlighting load; fastfetch banner shows.
5. Branch → PR → merge to main (rebase) → confirm clean.

## Risks / notes

- **sudo during apply:** the apt block prompts for the sudo password on an interactive apply. This
  is the one non-self-contained step; documented and warning-guarded.
- **apt package availability on noble:** `eza` is NOT reliably in noble's repos (hence binary
  download); the apt set (`btop chafa bat fd-find` + zsh plugins) is expected present in
  `universe` — verify at implementation; move any missing one to the binary-download path.
- **release asset names** for eza/sd/curlie/fastfetch must be verified against current releases at
  implementation (they change format occasionally).
- **idempotent + re-runnable**; `run_once_` re-runs only when the script content changes.
