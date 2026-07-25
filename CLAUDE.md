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

## Several sessions work this repo at once

Assume other Claude sessions are in this repo right now, in worktrees under
`.claude/worktrees/`. Both rules below come from incidents, not caution.

- **The index, stash stack, and `.git/config` are shared.** They are not per-worktree. Never
  `git stash` (even with a pathspec), reset, or otherwise rewrite the index — you will capture
  or destroy work in flight elsewhere. To compare against HEAD, `git show HEAD:<path>`. An
  unexpected `M ` entry or a `git status` that suddenly fails is someone else's work: report
  it, don't repair it.
- **Deployed usually means *ahead*, not stale.** Worktree jobs deploy a build straight to its
  target path to exercise it, and those bytes are the only copy. Read `chezmoi diff <path>`
  before `chezmoi apply`; if the diff *removes* things the source never had, another job owns
  that file — recover it from `.claude/worktrees/*/home/...` and leave it alone. The
  `chezmoi-apply-guard.sh` hook denies this case, but it only covers what chezmoi manages.

Integrate with `bin/land`, which rebases, pushes, and merges the PR under a repo-wide lock so
two sessions can't land onto a main the other is still moving. Background jobs don't run it —
they open a draft PR and stop there.

## Two different "sandboxes" — don't conflate

- **OS sandbox**: the `sandbox` block *inside* the generated `~/.claude/settings.json`
  (Seatbelt on macOS). Governs what the **Bash tool** can read/write/reach in a normal host
  session.
- **`claude-sandbox`**: a separate **Docker** tool under `home/private_dot_claude/sandbox/`
  (deployed to `~/.claude/sandbox/`) — a containerized Claude Code with its **own**
  `settings.base.json`, `sandbox-CLAUDE.md`, and entrypoint. Unrelated to the OS-sandbox
  block above; editing one does not affect the other.
