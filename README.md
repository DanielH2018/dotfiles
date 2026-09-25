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
- `docs/` — specs, plans, and decisions (not deployed); see `docs/README.md` for the layout
- `scheduled/` — launchd job definitions (not deployed). Deliberately outside `home/`: these
  must not be copied into `~/Library/LaunchAgents` by an apply, since the catch-up agent
  globs that directory and would replay a job that is meant to be inactive. Each plist
  documents its own activate/deactivate commands.
- `tests/` — unit tests (not deployed); run the full suite with `node --test`, which
  discovers them recursively. Grouped by subject (`agentview/`, `sandbox/`, `hooks/`,
  `install/`, `chezmoi/`, `terminal/`, `shell/`, `tmux/`, `dotsync/`, `tq/`, `evals/`,
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

- `config-soak status [--json] [--strict]` — fingerprint the tracked config, diff against the
  committed ledger (`config-soak.json`), and report
  `unrecorded`/`changed`/`removed`/`soaking`/`stable`/`neverFired`. Exits non-zero if any
  unreviewed change exists (the gate); `--strict` also fails it on `neverFired` entries.
- `config-soak land [PATH...]` — record the current config as reviewed; stamps `landed=now` for
  new/changed files, preserves the clock (and any recorded `outcome`) for unchanged ones. Commit
  the ledger to persist it.
- `config-soak outcomes [--since PATH]` — for every hook or `settings.*.json` ledger entry inside
  its soak window, ask this machine's local Loki (`http://127.0.0.1:3100`, read-only, no other
  host) whether the landed config actually fired since it landed, and write the answer back as
  that entry's `outcome: {checkedAt, fired, denied, errors, source, note}`. Attribution is only as
  fine as Claude Code's OTEL schema allows: a `settings.*.json` change is attributed to the merged
  permission ruleset's `tool_decision{source="config"}` events (the three templates cannot be told
  apart); a hook script is attributed only when it is the *sole* hook registered for a
  PreToolUse/PermissionRequest matcher (a shared matcher, or any other hook event — SessionStart,
  PostToolUse, Stop, ... — carries no field naming which hook fired, so those get `source:"none"`
  and an explanatory `note` rather than a false zero). `--since PATH` resumes a partial run
  (sorted path order), since each entry costs a live query. A `status` entry that soaked out with
  `outcome.fired === 0` and `source:"loki"` prints as "landed, never fired" — feed those to the
  `scaffolding-delete-pass` skill as removal candidates.
- `config-soak list` — print the tracked paths.

`status`, `land` and `list` are allow-listed in `settings.base.json`, so Claude runs them
unprompted — including `land`, which means Claude can acknowledge config it wrote itself. The
gate still records *what* changed and *when*; it no longer guarantees a human looked. `outcomes`
is deliberately NOT allow-listed (see the comment above the allow-list rules in
`settings.permissions.json`: the three documented verbs only, never a bare
`node bin/config-soak:*` wildcard, so a new subcommand is never pre-approved) — it makes a
network call, however narrow, and that crosses the line the other three don't. Invoke it as
`cd <repo-or-worktree> && node bin/config-soak <verb>`: the ledger is anchored to the script's own
location, so a worktree must run its own copy, and that compound form is the shape
`claude_guard.judge` auto-approves for the allow-listed verbs.

It is deterministic: no LLM and no judgement, only a fingerprint ledger. See
`docs/specs/2026-07-08-config-soak-gate-design.md` for the design rationale, including the
`outcomes` addition.

## pre-push gate — one-time install per clone

`.githooks/pre-push` runs config-soak, instruction quality, the injection red-team, and the
`node --test` suite. Git does not clone hook configuration, so **each clone must opt in once**:

```sh
git config core.hooksPath .githooks
```

Without it the hook is inert and every check above is advisory — the repo looks gated while
nothing runs. Verify with `git config core.hooksPath` (expect `.githooks`); a `git push` then
prints the four check headings before it contacts the remote.
