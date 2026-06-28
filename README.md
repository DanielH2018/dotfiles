# dotfiles (chezmoi)

Managed with [chezmoi](https://chezmoi.io). Source lives under `home/` (see `.chezmoiroot`).

## Bootstrap a machine

    sh -c "$(curl -fsLS get.chezmoi.io)" -- init --apply DanielH2018/dotfiles

You'll be prompted whether this is a **work** machine (gates work-only config).

### Linux server notes

Install the interactive tools the shell expects (configs degrade gracefully without them):

    zsh starship eza fzf zoxide fastfetch        # then: chsh -s "$(which zsh)"

## Layout

- `home/` — chezmoi source (dot_ files, templates)
- `docs/` — design + implementation docs (not deployed)
- `tests/` — unit tests (not deployed)

## Per-machine differences

- `.chezmoi.os` (auto) gates macOS-only config (Homebrew, ghostty, 1Password signing).
- `work` (prompted) gates work-only config (AWS/SSO, Snowflake, Lithic Grafana, 1Password keys).
