# Linux shell-tool installer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codify installation of the shell-experience CLI tools on daniel-server (apt + release-binary supplements), and fix the `fastfetch` login-banner guard.

**Architecture:** A Linux+hostname-gated chezmoi `run_once_before_` script installs apt packages, symlinks Ubuntu's renamed `batcat`/`fdfind` to real names, and downloads release binaries for the apt gaps (eza/sd/curlie/fastfetch) into `~/.local/bin`. A one-line `dot_zshrc.tmpl` guard fix stops the fastfetch banner erroring when the binary is absent.

**Tech Stack:** chezmoi templated scripts, POSIX `/bin/sh`, apt, curl/tar, zsh.

## Global Constraints

- chezmoi source root is `home/`; all target files live under `home/`.
- Installer is POSIX `/bin/sh`, `set -u` (NOT `set -e` over the whole body); every step idempotent.
- Gate: `{{ if and (eq .chezmoi.os "linux") (eq .chezmoi.hostname "daniel-server") }} … {{ end }}` (empty render → skipped elsewhere). `.chezmoi.hostname` == `daniel-server` (verified), arch amd64.
- `~/.local/bin` is on PATH via `dot_zshrc.tmpl`.
- apt set: `btop chafa bat fd-find zsh-autosuggestions zsh-syntax-highlighting`. Binary set: `eza sd curlie fastfetch`. Symlinks: `bat→batcat`, `fd→fdfind`.
- Tests are run with `node tests/<file>.test.js` (node from `~/.local/share/fnm/aliases/default/bin`).

---

### Task 1: Fix the fastfetch login-banner guard

**Files:**
- Modify: `home/dot_zshrc.tmpl` (the FASTFETCH section, ~line 244)

**Interfaces:**
- Consumes: the existing `fastfetch()` wrapper function at `dot_zshrc.tmpl:231`.
- Produces: a login banner that runs only when the fastfetch *binary* exists.

- [ ] **Step 1: Make the change** — in `home/dot_zshrc.tmpl`, replace the guard.

Old:
```sh
if [[ -o login ]] && command -v fastfetch >/dev/null 2>&1; then
  fastfetch
fi
```
New:
```sh
# `command -v` would match the fastfetch() wrapper function above (always true); $+commands
# tests zsh's external-command table, so the banner runs only when the binary is installed.
if [[ -o login ]] && (( $+commands[fastfetch] )); then
  fastfetch
fi
```

- [ ] **Step 2: Verify it renders and is valid zsh**

Run:
```sh
cd ~/.local/share/chezmoi && export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"
chezmoi execute-template < home/dot_zshrc.tmpl > /tmp/rz.zsh && zsh -n /tmp/rz.zsh && echo "zsh OK"
grep -n 'commands\[fastfetch\]' /tmp/rz.zsh
```
Expected: `zsh OK` and the grep shows the new guard line.

- [ ] **Step 3: Verify it fixes the error even without the binary** — at this point fastfetch is not yet installed, so a fresh login shell must be clean.

Run: `zsh -lic 'true' 2>&1 | grep -i "fastfetch.*not found" && echo "STILL BROKEN" || echo "guard fixed (no fastfetch error)"`
Expected: `guard fixed (no fastfetch error)` (note: requires `chezmoi apply` of the zshrc first — do Step 4 then re-run if testing live).

- [ ] **Step 4: Commit**

```sh
cd ~/.local/share/chezmoi
git add home/dot_zshrc.tmpl
git commit -m "fix(zsh): gate fastfetch banner on the binary, not the wrapper function

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add the CLI-tools installer script

**Files:**
- Create: `home/run_once_before_install-cli-tools.sh.tmpl`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `btop chafa bat fd eza sd curlie fastfetch` on PATH, plus the apt zsh plugins in
  `/usr/share/zsh-{autosuggestions,syntax-highlighting}/` (already sourced by `dot_zshrc.tmpl`).

- [ ] **Step 1: Create the script** — `home/run_once_before_install-cli-tools.sh.tmpl`:

```sh
{{ if and (eq .chezmoi.os "linux") (eq .chezmoi.hostname "daniel-server") -}}
#!/bin/sh
# Installs the shell-experience CLI tools on daniel-server (Ubuntu noble, amd64), mirroring the
# macOS Brewfile for Linux. apt for repo packages + release binaries for the gaps. run_once_:
# re-runs only when this script's contents change. Bump the marker to force a refresh.
# tools-bump: v1
set -u

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

# 1. apt packages (only if any are missing; needs sudo).
APT_PKGS="btop chafa bat fd-find zsh-autosuggestions zsh-syntax-highlighting"
missing=""
for p in $APT_PKGS; do
  dpkg -s "$p" >/dev/null 2>&1 || missing="$missing $p"
done
if [ -n "$missing" ]; then
  if sudo -v 2>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y $missing
  else
    echo "install-cli-tools: sudo unavailable; skipping apt packages:$missing" >&2
  fi
fi

# 2. Real-name symlinks for Ubuntu's renamed binaries (so the shell uses bat/fd).
for pair in "bat:batcat" "fd:fdfind"; do
  name="${pair%%:*}"; real="${pair##*:}"
  rp="$(command -v "$real" 2>/dev/null || true)"
  [ -n "$rp" ] && ln -sf "$rp" "$BIN_DIR/$name"
done

# 3. Release binaries for the apt gaps (no sudo). amd64 (gated to daniel-server).
latest_tag() { # $1=owner/repo -> latest tag via the releases/latest redirect (no API/ratelimit)
  curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" \
    | sed 's#.*/tag/##; s#[[:space:]]*$##'
}
install_release() { # $1=binname  $2=asset_url
  bin="$1"; url="$2"
  command -v "$bin" >/dev/null 2>&1 && return 0
  tmp="$(mktemp -d)"
  if curl -fsSL "$url" -o "$tmp/a.tgz" 2>/dev/null && tar xzf "$tmp/a.tgz" -C "$tmp" 2>/dev/null; then
    found="$(find "$tmp" -type f -name "$bin" 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      install -m 0755 "$found" "$BIN_DIR/$bin" && echo "install-cli-tools: installed $bin"
    else
      echo "install-cli-tools: $bin not found in archive ($url)" >&2
    fi
  else
    echo "install-cli-tools: failed to fetch $bin ($url)" >&2
  fi
  rm -rf "$tmp"
}

# version-less asset names → latest/download works directly
install_release eza       "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz"
install_release fastfetch "https://github.com/fastfetch-cli/fastfetch/releases/latest/download/fastfetch-linux-amd64.tar.gz"
# versioned asset names → resolve the tag first
ct="$(latest_tag rs/curlie)";  [ -n "$ct" ] && install_release curlie "https://github.com/rs/curlie/releases/download/$ct/curlie_${ct#v}_linux_amd64.tar.gz"
st="$(latest_tag chmln/sd)";   [ -n "$st" ] && install_release sd     "https://github.com/chmln/sd/releases/download/$st/sd-${st}-x86_64-unknown-linux-gnu.tar.gz"
{{ end -}}
```

- [ ] **Step 2: Verify it renders non-empty on this host**

Run: `cd ~/.local/share/chezmoi && export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH" && chezmoi execute-template < home/run_once_before_install-cli-tools.sh.tmpl | head -5`
Expected: prints the `#!/bin/sh` header + comments (gate renders the body on daniel-server).

- [ ] **Step 3: POSIX syntax check the rendered script**

Run: `cd ~/.local/share/chezmoi && export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH" && SP=$(mktemp) && chezmoi execute-template < home/run_once_before_install-cli-tools.sh.tmpl > "$SP" && sh -n "$SP" && echo "sh -n OK"`
Expected: `sh -n OK`.

- [ ] **Step 4: Verify the four release asset URLs resolve (catch asset-name drift)**

Run:
```sh
for u in \
  "https://github.com/eza-community/eza/releases/latest/download/eza_x86_64-unknown-linux-gnu.tar.gz" \
  "https://github.com/fastfetch-cli/fastfetch/releases/latest/download/fastfetch-linux-amd64.tar.gz"; do
  printf "%s -> " "$u"; curl -fsSL -o /dev/null -w '%{http_code}\n' "$u"
done
ct=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/rs/curlie/releases/latest | sed 's#.*/tag/##')
st=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/chmln/sd/releases/latest | sed 's#.*/tag/##')
curl -fsSL -o /dev/null -w "curlie -> %{http_code}\n" "https://github.com/rs/curlie/releases/download/$ct/curlie_${ct#v}_linux_amd64.tar.gz"
curl -fsSL -o /dev/null -w "sd -> %{http_code}\n" "https://github.com/chmln/sd/releases/download/$st/sd-${st}-x86_64-unknown-linux-gnu.tar.gz"
```
Expected: `200` for all four. If any is not 200, open that project's latest release page, correct the asset name in the script, and re-run.

- [ ] **Step 5: Commit**

```sh
cd ~/.local/share/chezmoi
git add home/run_once_before_install-cli-tools.sh.tmpl
git commit -m "feat(cli-tools): install shell-experience tools on daniel-server

apt (btop/chafa/bat/fd-find/zsh plugins) + bat/fd name symlinks + release
binaries for the apt gaps (eza/sd/curlie/fastfetch). Linux+hostname gated,
idempotent. Brewfile is macOS-only, so Linux had no install path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Apply on daniel-server, verify, PR

**Files:** none (operational).

- [ ] **Step 1: Apply** — runs the run_once installer (apt prompts for sudo) then the zshrc fix.

Run: `cd ~ && chezmoi apply 2>&1 | tail -20`
Expected: apt installs the missing packages; `install-cli-tools: installed eza/sd/curlie/fastfetch` lines; exit 0. (If a new dir mode prompt appears, the umask wrapper covers interactive use; for this Bash-tool apply, dir modes aren't created here.)

- [ ] **Step 2: Verify every tool resolves**

Run: `for t in eza bat fd btop chafa curlie sd fastfetch; do command -v "$t" >/dev/null 2>&1 && echo "OK   $t" || echo "MISS $t"; done`
Expected: `OK` for all 8.

- [ ] **Step 3: Verify the login shell is clean + plugins load**

Run: `zsh -lic 'true' 2>&1 | grep -iE "not found|error" && echo "ISSUES" || echo "login clean"`
Run: `zsh -ic 'echo $plugins; functions _zsh_autosuggest_start >/dev/null 2>&1 && echo "autosuggest loaded"; (( $+functions[_zsh_highlight] )) && echo "highlight loaded"' 2>&1 | tail -3`
Expected: `login clean`; autosuggest + highlight loaded (the apt plugins live in `/usr/share/...` which the zshrc sources).

- [ ] **Step 4: chezmoi state clean**

Run: `chezmoi status; echo "(empty=synced)"`
Expected: empty.

- [ ] **Step 5: Push + PR**

```sh
cd ~/.local/share/chezmoi
git push -u origin feat/linux-cli-tools
gh pr create --base main --fill
```

- [ ] **Step 6: After merge** — land on main and sync (rebase if main advanced).

```sh
cd ~/.local/share/chezmoi
git checkout main && git pull --ff-only origin main
# if the branch can't ff (main moved): git checkout feat/linux-cli-tools && git rebase main && \
#   git push --force-with-lease && git checkout main && git merge --ff-only feat/linux-cli-tools && git push origin main
```
