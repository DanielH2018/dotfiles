# Design: split dotfiles into a general repo + a work/laptop repo, with a preservation subsystem

Status: approved design (2026-06-28).

## Background

The dotfiles are managed by chezmoi (source `~/.local/share/chezmoi`, deployed from `home/`
via `.chezmoiroot`; see `docs/chezmoi-migration-design.md`). Today a single repo
(`DanielH2018/dotfiles`) holds **general**, **macOS-only**, and **work/Lithic** config together,
gated by `.chezmoi.os` and a prompted `work` boolean.

Goal: the dotfiles repo should contain **only configuration useful in general on other
computers**. Work/laptop-specific config (the `redact-pan` PCI hook, the work shell blocks,
the Lithic `CLAUDE.md` section, and `~/.claude/settings.json`) should move to a **separate
private repo with its own remote**, so it is still backed up against laptop loss but does not
pollute the general repo. A preservation subsystem must make it hard for any config to fall
through the cracks between the two repos.

## Decisions (from brainstorming)

1. **Split scope:** everything Lithic/work-specific moves out; the general repo ends up with
   zero Lithic references.
   - Correction from audit: **`protect-secrets.sh` is generic** (blocks reading
     `.env`/keys/`secrets` on any machine) and **stays** in the general repo. Only
     **`redact-pan.sh`** (payment-card / PCI) is work-specific and moves.
2. **Composition:** decoupled. The general repo carries only **generic extension points**
   (source/import/merge a local file *if present*) and never references the work repo. The
   only "work" signal it keeps is the existing chezmoi `work` boolean ("is this a work
   machine"), which gates behavior without naming any work content.
3. **Work-repo deployment:** Approach A — a **symlink farm**. The work repo mirrors the
   `$HOME` layout; an idempotent `install.sh` symlinks files into place. The repo *is* the
   live config, so `git commit && push` is the backup; no "apply" step after edits. chezmoi
   leaves the symlinks alone (unmanaged).
4. **Secrets:** a secret audit (2026-06-28) found **no plaintext secrets** in the work config.
   `settings.json` matches were deny-rules, hook paths, the 1Password agent socket path, and
   env-var *names* (`GITHUB_TOKEN`/`NPM_TOKEN`) in a deny-list. The shell `op://` lines are
   1Password *references* (vault names + item UUIDs) resolved via Touch ID, not credentials.
   → a **private** GitHub repo in plaintext is acceptable; **no encryption** needed. The
   `op://` references are reason enough to keep the repo private.
5. **Preservation:** all four requested capabilities, delivered as one subsystem `dotsync`
   (manifest + checker + sync + restore). The tool lives in the **general** repo.

## Repos

- **`DanielH2018/dotfiles`** (existing, chezmoi): becomes 100% work-agnostic. General config +
  generic extension points + the `dotsync` tool and the general manifest.
- **`DanielH2018/work-laptop-config`** (new, **private**; name is the user's to finalize): all
  Lithic/laptop-specific config, symlink-deployed via `install.sh`.

## General repo: extension points

Each is inert when the local file is absent, so the general repo is portable.

| Concern | General repo provides | Filled on the work laptop by |
|---|---|---|
| Interactive shell | `home/dot_zshrc.tmpl` ends with `[[ -r "$HOME/.config/zsh/local.zsh" ]] && source "$HOME/.config/zsh/local.zsh"`; **all `{{ if .work }}` blocks removed** (AWS/SSO, Snowflake, 1P key-loading, `GRAFANA_URL`) | `~/.config/zsh/local.zsh` |
| Login shells | Snowflake PATH removed from `home/dot_zprofile.tmpl` and `home/dot_bash_profile.tmpl` (folds into `local.zsh`, which is sourced from the interactive shell) | — |
| Claude memory | `home/private_dot_claude/CLAUDE.md.tmpl` keeps the general baseline; ends with optional `@~/.claude/CLAUDE.local.md`; the Lithic/PCI/planner-implementer section and the `integrations.md`/`enforcement.md` imports are removed | `~/.claude/CLAUDE.local.md` (which itself imports its own docs) |
| Git identity | `home/dot_gitconfig.tmpl` `{{ if .work }}` name replaced with `[include] path = ~/.config/git/local.config` | `~/.config/git/local.config` (`[user] name = Daniel Hunter`) |
| PCI hook | `redact-pan.sh` **removed** from `home/private_dot_claude/hooks/` (all other hooks, incl. `protect-secrets.sh`, stay) | `~/.claude/hooks/redact-pan.sh` |
| `settings.json` | `home/private_dot_claude/modify_settings.json` is gated **off** on work machines via `.chezmoiignore` (`{{ if .work }} private_dot_claude/modify_settings.json {{ end }}`); on non-work machines it still injects the `claude-permission-audit` plugin | the work repo owns the whole file (see below) |

After this refactor the `work` variable is still used (only) to gate `modify_settings.json`
(and possibly the statusline work bit — see open items). `.chezmoi.os` gating is unchanged.

## Work repo structure

```
work-laptop-config/            (private)
  install.sh                   # idempotent: mkdir -p parents + ln -sfn each file below
  uninstall.sh                 # removes the symlinks (restore-safety)
  README.md                    # bootstrap + what this repo owns
  manifest.d/50-work.toml      → ~/.config/dotsync/manifest.d/50-work.toml
  .claude/
    settings.json              → ~/.claude/settings.json
    CLAUDE.local.md            → ~/.claude/CLAUDE.local.md
    hooks/redact-pan.sh        → ~/.claude/hooks/redact-pan.sh
    docs/integrations.md       → ~/.claude/docs/integrations.md
    docs/enforcement.md        → ~/.claude/docs/enforcement.md
  .config/
    zsh/local.zsh              → ~/.config/zsh/local.zsh
    git/local.config           → ~/.config/git/local.config
```

`install.sh` uses `ln -sfn` and creates parent dirs; re-running is a no-op. It also registers
the work repo with `dotsync` by linking `manifest.d/50-work.toml`.

## settings.json model

`~/.claude/settings.json` is fixed-location and mixes general (`permission-audit` plugin) with
work concerns (Lithic plugins, `redact-pan` wiring, paths). Model:

- **On the work laptop:** owned wholesale by the work repo (symlinked). Its copy *includes* the
  permission-audit plugin. chezmoi's `modify_settings.json` is gated off on work machines, so
  chezmoi never touches the symlink.
- **On any non-work machine:** `modify_settings.json` creates/merges a minimal `settings.json`
  containing only the permission-audit plugin (current behavior).
- **Backup:** the work repo (the symlink target is the tracked file).

## Preservation subsystem: `dotsync`

One generic, manifest-driven tool shipped by the general repo into `~/.local/bin/dotsync`
(chezmoi target `home/dot_local/bin/executable_dotsync`), available on every machine. Work-
agnostic: it discovers repos and tracked paths from manifest fragments, never hardcoding the
work repo.

### Manifest

Fragments at `~/.config/dotsync/manifest.d/*.toml`, merged in lexical order. The manifest is
**small and declarative** — it registers repos and the ignore baseline; the per-file tracked set
is **derived** from each repo (never hand-listed), so it cannot drift:

- `00-general.toml` — shipped by the general repo (chezmoi). Registers the chezmoi repo and the
  intentionally-untracked baseline.
- `50-work.toml` — shipped by the work repo (symlinked by its `install.sh`). Registers the work
  repo. Absent on personal machines, so `dotsync` naturally scopes to one repo.

Schema sketch:

```toml
[[repo]]
name   = "general"
type   = "chezmoi"                       # chezmoi | git-symlink
path   = "~/.local/share/chezmoi"
remote = "git@github.com:DanielH2018/dotfiles.git"
# tracked targets are derived: `chezmoi managed --include=files`

[[repo]]                                  # only in 50-work.toml
name   = "work"
type   = "git-symlink"
path   = "~/work-laptop-config"
remote = "git@github.com:DanielH2018/work-laptop-config.git"
# tracked targets are derived: the symlink targets of files tracked by `git ls-files`

# Globs that are deliberately NOT version-controlled (and why) — also the manual-restore checklist.
[ignore]
globs = [
  "~/.claude/projects/**",              # per-machine memory
  "~/.config/gh/hosts.yml",             # gh auth token
  "~/.cache/**", "~/.local/state/**",   # runtime/cache
  "~/.config/op/**",                    # 1Password runtime
]
```

The derived ownership map is what makes orphan detection reliable: `check` unions the derived
target sets from all repos, and anything under the scanned roots that is in neither set and
matches no ignore glob is an orphan. A file claimed by *two* repos is also flagged (a conflict).

To satisfy "explicit inventory of everything" without hand-maintenance, `dotsync inventory`
materializes the current derived map to `~/.config/dotsync/INVENTORY.md` (path → owning repo),
regenerated on demand and by `sync`. The generated file is the human-readable manifest; the
declarative fragments stay the source of truth.

### Subcommands

- **`dotsync check`** — for every `tracked` entry: confirm the file exists and is tracked by its
  declared repo (`chezmoi managed` for `type=chezmoi`; `git -C <path> ls-files --error-unmatch`
  for `git-symlink`). Then scan config roots (`$HOME` top-level dotfiles, `~/.config`,
  `~/.claude`) for anything **covered by no `tracked` entry and matching no `ignore` glob** →
  report as an **orphan** to triage. Non-zero exit if orphans or missing/untracked entries.
- **`dotsync status`** — `git status -sb` for each registered repo (for chezmoi, also
  `chezmoi diff --no-pager` summary).
- **`dotsync sync`** — run `check` (warn, and require `--force` to proceed past orphans);
  regenerate `INVENTORY.md`; then per repo: `type=chezmoi` → `chezmoi re-add` (capture live edits
  into source) + commit + push; `type=git-symlink` → `git add -A` + commit + push. One command
  backs up the whole laptop.
- **`dotsync inventory`** — regenerate `~/.config/dotsync/INVENTORY.md` (the materialized
  path → owning-repo map). Run by `sync`; also runnable on demand.

### Restore

`RESTORE.md` (in the general repo) documents the bootstrap:
1. General: install chezmoi, `chezmoi init --apply DanielH2018/dotfiles` (answer `work`).
2. Work: clone `work-laptop-config`, run `install.sh`.
3. `dotsync check` — confirm every manifest path landed.
4. Work through the `[ignore]` list as the manual checklist (sign into 1Password, etc.).

Each repo's `README.md` documents its own bootstrap; `RESTORE.md` is the combined flow.

### Scope guard (YAGNI)

One script with `check`/`status`/`sync`, one merged manifest, one restore doc. No daemon, no
file watching, no auto-commit.

## Migration sequence

1. Create the private work repo with the structure above; copy the current work files into it
   (`~/.claude/settings.json`, `redact-pan.sh`, the work shell blocks → `local.zsh`, the Lithic
   `CLAUDE.md` section + `integrations.md`/`enforcement.md` → `CLAUDE.local.md` + docs, the work
   git name → `local.config`). Write `install.sh` + `50-work.toml`.
2. In the general repo: remove the work content, add the extension points, gate
   `modify_settings.json` off on work, add the `dotsync` tool + `00-general.toml` + `RESTORE.md`.
3. Run the work repo's `install.sh` → live files become symlinks into the work repo.
4. `chezmoi apply` the general repo; confirm `chezmoi diff` is clean and that the shell + Claude
   still behave (work content loads via the symlinked local files). Run `dotsync check` → expect
   zero orphans.
5. Commit + push both repos (via `dotsync sync` once it exists).

A timestamped backup (tarball of `~/.claude`, the shell dotfiles, and `~/.gitconfig`) is taken
before step 3, per the project's established pre-change practice.

## Known limitation (out of scope)

General hook **wiring** currently lives inside the laptop `settings.json`, so a fresh *general*
(non-work) machine receives the hook *scripts* via chezmoi but not their wiring. Extracting a
general hook-wiring fragment into the general repo is deferred; noted so it is not lost.

## Open items to verify during implementation

- **Claude Code ignores a missing `@~/.claude/CLAUDE.local.md` import** without error/noise on
  non-work machines. Fallback if not: drop the import from the general `CLAUDE.md` and have the
  work repo's `install.sh` assemble `~/.claude/CLAUDE.md` from general + work parts instead.
- **The `.work`-gated bit inside `home/private_dot_claude/executable_statusline-command.sh`** —
  inspect it; either keep it gated (hides work info elsewhere) or move it into `local.zsh`/work
  config. Decide during implementation.
- **Apply/install ordering** does not double-manage `settings.json` (chezmoi gated off on work +
  work symlink). Verify a second `chezmoi apply` and `dotsync sync` are both clean/idempotent.
- **`chezmoi re-add` in `dotsync sync`** does not clobber templated source files (it re-adds
  concrete targets; templated entries must be excluded or handled). Confirm behavior before
  relying on it; if unsafe, `sync` for the chezmoi repo just commits existing source changes and
  leaves capturing-live-edits to `chezmoi re-add` run manually.
