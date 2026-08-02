# dotfiles (chezmoi)

Managed with [chezmoi](https://chezmoi.io). Source lives under `home/` (see `.chezmoiroot`).

## Bootstrap a machine

    sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply DanielH2018/dotfiles

You'll be prompted whether this is a **work** machine (gates work-only config).

### Linux notes

`chezmoi apply` provisions the CLI toolchain itself on **Debian/Ubuntu (apt)** and
**Fedora (dnf)**; package names per distro live in `home/.chezmoidata/tools.toml`. Tools with
no `apt`/`dnf` entry (eza, fzf, zoxide, ripgrep, starship, fastfetch, curlie, sd, nvim, yazi)
come from GitHub release binaries on *every* Linux, so the two distros run one code path.

On any other distro the installer warns, skips the package phase, and still lays down the
release binaries — install these by hand for the full experience (configs degrade gracefully
without them):

    zsh starship eza fzf zoxide fastfetch        # then: chsh -s "$(which zsh)"

Two Fedora-specific divergences, both because Fedora packages neither tool: WezTerm comes from
upstream's `wezfurlong/wezterm-nightly` COPR, and `gron` falls back to its GitHub release binary.

## Layout

- `home/` — chezmoi source (dot_ files, templates)
- `docs/` — design + implementation docs (not deployed)
- `tests/` — unit tests (not deployed); run the full suite with `node --test`

### Windows notes

On Windows, `chezmoi apply` runs `run_onchange_install-nerd-font.ps1.tmpl` (PowerShell): it
installs **IosevkaTerm Nerd Font** per-user and sets VS Code's `terminal.integrated.fontFamily`
so the starship prompt's glyphs render (no admin, no manual steps). Over VS Code Remote-SSH the
terminal renders locally, so the font must be on the Windows client — this handles it. Restart
VS Code after the first apply.

## Per-machine differences

- `.chezmoi.os` (auto) gates macOS-only config (Homebrew, ghostty, 1Password signing) and the
  Windows-only Nerd Font installer.
- `work` (prompted) gates work-only config (AWS/SSO, Snowflake, Lithic Grafana, 1Password keys).

## dotsync — config preservation

`dotsync` (deployed to `~/.local/bin/dotsync`) is a manifest-driven tool that prevents
config from falling through the cracks between the general (chezmoi) repo and the private
work repo. It derives each repo's tracked targets (`chezmoi managed` / `git ls-files`),
so the ownership map never drifts.

- `dotsync check` — orphans (untracked, non-ignored), conflicts (claimed by 2 repos), and
  missing declared targets. Non-zero exit on any.
- `dotsync status` — `git status -sb` per repo (+ `chezmoi diff` indicator for the chezmoi repo).
- `dotsync sync [--force] [--dry-run]` — runs `check` (needs `--force` past orphans),
  regenerates `INVENTORY.md`, then per repo: chezmoi → `re-add` + commit + push;
  git-symlink → `add -A` + commit + push. `--dry-run` prints the plan and mutates nothing.
- `dotsync inventory` — regenerate `~/.config/dotsync/INVENTORY.md` (path → owning repo).

Manifest fragments live in `~/.config/dotsync/manifest.d/*.json` (merged in lexical order).
See `docs/RESTORE.md` for the bare-metal bootstrap.

## config-soak — review + soak gate for behavior-affecting config

`bin/config-soak` (repo tooling, not deployed) treats behavior-affecting Claude Code config —
`settings.base.json`, hooks, agents, skills, `CLAUDE.md` — like code: a change must be consciously
acknowledged before it counts as reviewed, and is only flagged stable after a soak window.

- `config-soak status [--json]` — fingerprint the tracked config, diff against the committed
  ledger (`config-soak.json`), and report `unrecorded`/`changed`/`removed`/`soaking`/`stable`.
  Exits non-zero if any unreviewed change exists (the gate).
- `config-soak land [PATH...]` — record the current config as reviewed; stamps `landed=now` for
  new/changed files, preserves the clock for unchanged ones. Commit the ledger to persist it.
- `config-soak list` — print the tracked paths.

All three verbs are allow-listed in `settings.base.json`, so Claude runs them unprompted — including
`land`, which means Claude can acknowledge config it wrote itself. The gate still records *what*
changed and *when*; it no longer guarantees a human looked. Invoke it as
`cd <repo-or-worktree> && node bin/config-soak <verb>`: the ledger is anchored to the script's own
location, so a worktree must run its own copy, and that compound form is the shape
`allow-compound-bash.sh` auto-approves.

It is the deterministic complement to the LLM-driven `/review-setup` skill. See
`docs/specs/2026-07-08-config-soak-gate-design.md` for the design rationale.

## pre-push gate — one-time install per clone

`.githooks/pre-push` runs config-soak, instruction quality, the injection red-team, and the
`node --test` suite. Git does not clone hook configuration, so **each clone must opt in once**:

```sh
git config core.hooksPath .githooks
```

Without it the hook is inert and every check above is advisory — the repo looks gated while
nothing runs. Verify with `git config core.hooksPath` (expect `.githooks`); a `git push` then
prints the four check headings before it contacts the remote.
