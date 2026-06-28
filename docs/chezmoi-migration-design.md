# Design: chezmoi cross-platform dotfiles + permission-audit plugin

Status: approved design (2026-06-28). Implementation tracked on branch `feat/chezmoi`.

## Background

This repo originated on a Work MacBook and is now meant to be shared across three
machines: **Work Mac** (macOS, work), **Windows PC** (personal), and a **Linux homelab
server** (`daniel-server`, headless, personal). Today it is a flat collection of dotfiles
with a `.gitignore` that ignores `*` and allowlists explicit paths — the signature of the
"bare git repo checked out at `$HOME`" pattern — but with **no installer, no README, and
no machine-divergence mechanism**.

Several files that live in the repo as if they were "shared" are in fact **Work-Mac /
Lithic-specific** and would actively harm a fresh machine if applied verbatim (details
below). Separately, a portable Claude Code plugin (`DanielH2018/claude-permission-audit`)
exists and should be brought into the shared setup.

The immediate target is the **Linux server**; the design must also be correct for the Mac
and forward-compatible with Windows.

## Goals

1. Adopt **chezmoi** as the dotfile manager, converting this repo into chezmoi source
   format on branch `feat/chezmoi`.
2. **Behavior-preserving on macOS** — every template's `darwin` / `work` branch reproduces
   today's exact file contents, so the *file conversions* are a no-op for the Work Mac and
   only *add* the Linux (and later Windows) code paths. The one deliberate cross-machine
   *addition* is enabling the permission-audit plugin (goal 5), applied additively and
   idempotently on every machine including the Mac — this is intended new shared config,
   not a regression.
3. **Do no harm to the Linux server's existing setup**, in particular the heavily
   customized homelab project config at `/home/ubuntu/server/.claude/` and the clean
   global `~/.claude/settings.json`.
4. Bring the **general** shell + Claude customizations to the server while keeping
   **work-specific** bits off it — without affecting the Mac.
5. Install the **claude-permission-audit plugin** as shared config across machines.

## Non-goals (this pass)

- Windows `install.ps1` / native Windows validation (design stays compatible; tested later).
- A Linux package manifest equivalent to `Brewfile` (apt / Homebrew-on-Linux).
- Migrating the homelab repo off its Python permission-audit onto the plugin (explicitly
  **kept** as-is; see Plugin plan).

## Key constraints discovered

- chezmoi only ever manages files under `$HOME`. The homelab **project** config at
  `/home/ubuntu/server/.claude/` is therefore structurally out of scope and cannot be
  touched by `chezmoi apply`. Only the **global** `~/.claude/` is in scope.
- Default shell on the server is **bash**; `zsh` is not installed.
- The repo's `.claude/settings.json` references ~7 hook scripts that do not exist even in
  the repo, plus private work plugins/marketplaces and `/Users/daniel` paths — it is **not
  safely shareable** and must never overwrite another machine's settings.
- The repo's global `.claude/CLAUDE.md` is Lithic-specific and `@`-imports two files
  (`~/.claude/docs/integrations.md`, `enforcement.md`) that are not in the repo.
- The plugin and the homelab's Python logger both default to
  `<project>/.claude/logs/permissions.json` and both honor `PERMLOG_STORE` — so they
  collide if both run on the same project. The homelab logger is wired at **project**
  scope, so the collision is limited to the homelab repo only.

## Approach: chezmoi

chezmoi renders a source repo into `$HOME` (copy/template, not symlink). Per-machine
differences are handled with Go templates that branch on machine facts. This directly
solves "general bits everywhere, work bits only on work" in a single source file, has
first-class Windows support, and provides `chezmoi diff` as a pre-apply safety net.

### Machine fact / data model

- `.chezmoi.os` — automatic (`darwin` / `linux` / `windows`).
- `work` — a boolean prompted once per machine (stored in chezmoi state via
  `promptBoolOnce` in `.chezmoi.toml.tmpl`). Work Mac = `true`; server = `false`;
  Windows = decided at init.

Gating convention:
- **Mac-only but not work** (Homebrew, `ARCHFLAGS`, 1Password SSH agent socket, Docker
  Desktop completions, ghostty) → `{{ if eq .chezmoi.os "darwin" }}`.
- **Work** (Grafana URL, AWS/SSO block, 1Password-Lithic key loading, Snowflake,
  `~/Documents/My_Vault`) → `{{ if .work }}`.

### Source layout (on `feat/chezmoi`)

```
.chezmoi.toml.tmpl          # prompts for `work`
.chezmoiignore              # templated: exclude Mac/work-only trees on linux
dot_zshrc.tmpl              # split general / {{ if .work }} / {{ if darwin }}
dot_zshenv.tmpl            # cargo env, guarded by file-exists
dot_zprofile.tmpl         # brew + Snowflake → darwin/work only
dot_bash_profile.tmpl     # sdkman/cargo/snowflake → darwin/work only
dot_gitconfig.tmpl        # shared bits; SSH signing gated to darwin
dot_tmux.conf             # functional superset, no phone-access comment
dot_gitignore_global
Brewfile                   # darwin only (.chezmoiignore)
dot_config/
  starship.toml            # portable as-is
  fastfetch/...            # portable
  ghostty/...              # darwin only (.chezmoiignore)
private_dot_claude/
  CLAUDE.md.tmpl           # general baseline + {{ if .work }} block
  rules/*.md               # portable
  commands/*               # portable (audit create-pr/git-* for 1P-isms)
  statusline-command.sh, keybindings.json   # portable
  hooks/*, sandbox/*       # darwin only (.chezmoiignore) — unwired here anyway
  # settings.json handled by modify_ script (merge), NOT a managed file
  # projects/** intentionally unmanaged (per-machine memory)
docs/chezmoi-migration-design.md   # this spec
README.md                  # per-OS bootstrap instructions
```

The current `ignore *` `.gitignore` is replaced with a normal one (chezmoi tracks the
source files directly; on-apply exclusions move to `.chezmoiignore`).

## Shell plan (`.zshrc` split)

`.zshrc` is refactored in place into a template. Classification:

- **General (all machines):** interactive guard, history + zsh options, `EDITOR=vim`,
  `$HOME/.local/bin` + `go/bin` PATH, fnm, completion system, starship, zoxide, fzf,
  eza/ls aliases, fd/curlie helpers, QoL aliases, keybindings, fastfetch-on-login,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, zsh autosuggestions / syntax-highlighting.
- **Work (`{{ if .work }}`):** `GRAFANA_URL`, the AWS/SSO block + `aws_completer`,
  the 1Password-Lithic key machinery (macOS `security` keychain + `op`), Snowflake PATH,
  `vault` alias.
- **Mac (`{{ if darwin }}`):** Homebrew prefix/init, `ARCHFLAGS`, hardcoded
  `/opt/homebrew/python@3.14` PATH, `SSH_AUTH_SOCK` (1Password), Docker Desktop
  completions, ghostty `configterminal` alias.

Improvements folded in (must stay behavior-preserving on Mac):
- Make the zsh-plugin and fzf `source` paths **path-agnostic** (check `/usr/share/...` in
  addition to `$BREW_PREFIX/share/...`) so autosuggestions/syntax-highlighting/fzf load on
  Linux too.
- Drop the obsolete `dotfiles` bare-repo git alias (chezmoi replaces it).

## Claude config plan (global `~/.claude/`)

- **`settings.json` — merge, never overwrite.** A chezmoi `modify_` script written in
  **node** (present on all three machines) reads the machine's current `settings.json` on
  stdin and injects only:
  - `extraKnownMarketplaces.daniel-tools = { source: { source: "github", repo:
    "DanielH2018/claude-permission-audit" } }`
  - `enabledPlugins["claude-permission-audit@daniel-tools"] = true`

  All other keys are preserved untouched. The server's existing global settings survive
  and merely gain the plugin.
- **`CLAUDE.md`** — templated: a general baseline (terse communication, `file:line` refs,
  why-not-what commit messages, "don't over-refactor / don't add unrequested
  docstrings", compaction policy) applies everywhere; the Lithic/PCI/planner-implementer
  block and the `@~/.claude/docs/*` imports are gated behind `{{ if .work }}`.
- **rules / commands / statusline / keybindings** — portable; managed everywhere.
- **hooks/ + sandbox/** — excluded on linux via `.chezmoiignore`. They are inert on the
  server (the merged `settings.json` never wires them), so deploying them would be
  pointless clutter; they remain in source for the Mac.
- **projects/** (memory) — unmanaged (per-machine).

## Plugin plan (`claude-permission-audit`)

- **Install globally** through the `settings.json` merge above → active on the Mac,
  Windows, and every project on the server *except* the homelab repo.
- **No double-logging on the homelab repo.** Primary mechanism: set
  `enabledPlugins["claude-permission-audit@daniel-tools"] = false` in
  `/home/ubuntu/server/.claude/settings.json` (project scope overriding user scope). This
  must be **verified** to actually disable the plugin for that project before being relied
  on. Documented fallback if project-level disable is unsupported: do **not** enable the
  plugin globally on the server (keep it to Mac/Windows); the homelab's Python tooling is
  unaffected either way.
- The homelab's Python permission-audit (logger + `audit-permissions.py` +
  `/audit-permissions` skill) stays **100% untouched**.
- **Optional improvement follow-up:** compare the homelab `audit-permissions.py` with the
  plugin's `audit-permissions.js` and port any missing capabilities (e.g. dead /
  hook-covered / redundant-rule detection and pruning) into the plugin repo. Scoped
  separately so it cannot block the dotfiles work.

## Server bring-up sequence

1. Install `zsh` + tools the `.zshrc` uses: `starship eza fzf zoxide fastfetch`;
   `chsh -s "$(which zsh)"`. `command -v` guards make a partial install safe.
2. Install chezmoi (single binary into `~/.local/bin`).
3. `chezmoi init` against the repo branch; answer `work = false`.
4. `chezmoi diff` to preview; back up the real collisions (`~/.gitconfig`,
   `~/.tmux.conf`); `~/.claude/settings.json` is merged (additive) so it is not at risk;
   then `chezmoi apply`.

## Safety / rollback

- All work on `feat/chezmoi`; nothing merged until validated on the Mac.
- `chezmoi diff` previews every change; timestamped backups of any replaced file.
- `settings.json` is merged (additive), never overwritten.
- chezmoi never touches the homelab project config under `/home/ubuntu/server/`.

## Validation (on the server)

- `zsh` loads clean; starship / zoxide / fzf / eza active; **no** work noise (no AWS, `op`,
  Snowflake errors).
- `chezmoi diff` clean after apply; second `chezmoi apply` is a no-op (idempotent).
- `git` and `tmux` behave; `~/.gitconfig` is Linux-correct (no 1Password signing program).
- `claude` shows the plugin enabled globally and **disabled on the homelab repo**; the
  homelab Python logger remains the only logger there; `permissions.json` stays
  single-format.

## Open items to verify during implementation

- Project-scope `enabledPlugins: false` actually disables a user-enabled plugin.
- Private-repo plugin/marketplace fetch works with the server's existing GitHub auth.
- `en_US.UTF-8` locale availability on the server (for `LANG`/`LC_ALL`); generate if absent.
