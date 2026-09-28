# dotfiles (chezmoi)

Managed with [chezmoi](https://chezmoi.io). Source lives under `home/` (see `.chezmoiroot`).

## Bootstrap a machine

    sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply DanielH2018/dotfiles

You'll be prompted whether this is a **work** machine (gates work-only config). See
`docs/RESTORE.md` for the bare-metal bootstrap.

### Linux notes

`chezmoi apply` provisions the CLI toolchain itself on **Debian/Ubuntu (apt)** and
**Fedora (dnf)**; package names per distro live in `home/.chezmoidata/tools.toml`. Tools with
no `apt`/`dnf` entry (eza, fzf, zoxide, ripgrep, starship, fastfetch, curlie, sd, nvim, yazi)
come from GitHub release binaries on *every* Linux, so the two distros run one code path.

On any other distro the installer warns, skips the package phase, and still lays down the
release binaries — install these by hand for the full experience (configs degrade gracefully
without them):

    zsh starship eza fzf zoxide fastfetch        # then: chsh -s "$(which zsh)"

One Fedora-specific divergence, because Fedora doesn't package it: `gron` falls back to its
GitHub release binary.

## Layout

- `home/` — chezmoi source (dot_ files, templates)
- `docs/` — specs, plans, and decisions (not deployed); see `docs/README.md` for the layout
- `scheduled/` — launchd job definitions (not deployed). Deliberately outside `home/`: these
  must not be copied into `~/Library/LaunchAgents` by an apply, since the catch-up agent
  globs that directory and would replay a job that is meant to be inactive. Each plist
  documents its own activate/deactivate commands.
- `tests/` — unit tests (not deployed); run the full suite with `node --test`, which
  discovers them recursively. Grouped by subject (`agentview/`, `sandbox/`, `hooks/`,
  `install/`, `chezmoi/`, `terminal/`, `shell/`, `tmux/`, `tq/`, `evals/`,
  `bin/`, `settings/`), with shared helpers in `lib/`. A suite one level down reaches the
  repo with `path.join(__dirname, '..', '..')`; the files still at the root use a single
  `'..'`. What stays at the root is what belongs to no single subsystem: the cross-cutting
  guards (`lint-gate-coverage`, `secret-registry`) and the meta-tests that wire another
  suite into `node --test` (`python-suites`, `skill-selftests`, `tq-digest`,
  `vault-audit-portable-suites`).

### Windows notes

On Windows, `chezmoi apply` runs `run_onchange_install-nerd-font.ps1.tmpl` (PowerShell): it
installs **IosevkaTerm Nerd Font** per-user and sets VS Code's `terminal.integrated.fontFamily`
so the starship prompt's glyphs render (no admin, no manual steps). Over VS Code Remote-SSH the
terminal renders locally, so the font must be on the Windows client — this handles it. Restart
VS Code after the first apply.

## Per-machine differences

- `.chezmoi.os` (auto) gates macOS-only config (Homebrew, 1Password signing) and the
  Windows-only Nerd Font installer.
- `work` (prompted) gates work-only config (AWS/SSO, Snowflake, Lithic Grafana, 1Password keys).

## pre-push gate — one-time install per clone

`.githooks/pre-push` runs the commit-signature check and the pre-commit lint hooks (`prek run
--all-files`), a few seconds in all. The heavy suite (eval freshness, instruction quality, the
injection red-team and the `node --test` suite) is `bin/gate`, which the required CI `gate` job
runs on every PR and every push to main, and which you can run by hand before pushing. Git does
not clone hook configuration, so **each clone must opt in once**:

```sh
git config core.hooksPath .githooks
```

Without it the hook is inert and the local checks are advisory — the repo looks gated while
nothing runs. Verify with `git config core.hooksPath` (expect `.githooks`); a `git push` then
prints the two check headings before it contacts the remote.
