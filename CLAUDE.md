# dotfiles (chezmoi source)

Personal, work-agnostic base config, managed by **chezmoi**. Public repo — never commit
work-specific content, secrets, or `.local` files here (guarded in `.chezmoiignore` + `.gitignore`).

Fuller cross-layer map (base + overlay + sandbox + vault) lives in the personal knowledge
vault, `Work/Claude_Code_Setup.md` — not in this repo.

## Layout

- `home/` is the chezmoi source root (`.chezmoiroot`). Files under it deploy to `$HOME`
  (`dot_` → `.`, `private_` → mode 0700, `*.tmpl` → templated, `modify_`/`run_` → scripts).
- Everything **outside** `home/` (this file, `bin/`, `config-soak.json`) is repo tooling and
  is **not** deployed.

## Editing rules

- Edit the **source** under `home/`, never the deployed copy in `$HOME`. `chezmoi apply` is
  the trust boundary — changes don't reach `$HOME` until you apply.
- `~/.claude/settings.json` is **generated — do not hand-edit**. It is
  `merge(home/.chezmoitemplates/settings.base.json, optional machine-local work overlay)`
  via `home/private_dot_claude/modify_settings.json.sh.tmpl` +
  `home/dot_local/bin/executable_claude-settings-merge` (arrays concat+dedupe, scalars
  overlay-wins). Change the base template, then `chezmoi apply`.

## Two different "sandboxes" — don't conflate

- **OS sandbox**: the `sandbox` block *inside* the generated `~/.claude/settings.json`
  (Seatbelt on macOS). Governs what the **Bash tool** can read/write/reach in a normal host
  session.
- **`claude-sandbox`**: a separate **Docker** tool under `home/private_dot_claude/sandbox/`
  (deployed to `~/.claude/sandbox/`) — a containerized Claude Code with its **own**
  `settings.base.json`, `sandbox-CLAUDE.md`, and entrypoint. Unrelated to the OS-sandbox
  block above; editing one does not affect the other.
