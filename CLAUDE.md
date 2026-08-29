# dotfiles (chezmoi source)

Personal, work-agnostic base config, managed by **chezmoi**. **Treat it as public** — never
commit work-specific content, secrets, or `.local` files here (guarded in `.chezmoiignore` +
`.gitignore`, and by the gitleaks hook in `.pre-commit-config.yaml`).

The repo is in fact **private** on GitHub; this line read "Public repo" until it was checked.
The posture stands either way, but the visibility is load-bearing for one decision: branch
protection needs a paid plan on a private repo, so the answer to "nothing enforces the gate
server-side" is GitHub Actions, not a protected branch.

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
two sessions can't land onto a main the other is still moving. Nothing runs it unasked: a
session that finishes work opens a draft PR and stops there, background jobs included.

But when you *are* asked to land something, run `bin/land` yourself — don't print the command
for the operator to paste back. It is yours to run, not to recommend. The general rule you
carry ("never push to main, force-push, or merge") is about doing those by hand to a branch
you were not asked to integrate; `land` is exactly how this repo does them safely — under the
lock, through the PR, on request. If a permission prompt fires on the invocation, that is the
confirmation step — let it, instead of pre-empting it with a command to paste.

To *test* a branch, don't go to its worktree — bring it to the primary checkout with
`bin/try <branch>`, and `bin/try --back` when you're done. It detaches onto the branch, which
git permits even while a worktree still holds it, or fast-forwards main onto it with
`--merge`; then it deploys. Going to the worktree instead is not just inconvenient, it is
wrong: chezmoi reads its source from `~/.local/share/chezmoi`, so an apply from a worktree
needs `--source`, and a plain apply from the primary checkout deploys main rather than the
branch you meant to test. `try` holds its own lock and makes the same refusal
`chezmoi-apply-guard.sh` does, since that hook matches the Bash command string and never sees
the apply inside a script.

Same rule as `land` on who runs it, for a different reason: `try` moves the primary checkout's
HEAD and deploys to `$HOME`, which is the operator's live config, so don't put a branch on the
bench on your own initiative. Asked to, though, you run it — `bin/try --dry-run` and
`bin/try --diff` are there for showing what a bench would do, which is a better answer than
handing over a command to paste.

## Two different "sandboxes" — don't conflate

- **OS sandbox**: the `sandbox` block *inside* the generated `~/.claude/settings.json`
  (Seatbelt on macOS). Governs what the **Bash tool** can read/write/reach in a normal host
  session.
- **`claude-sandbox`**: a separate **Docker** tool under `home/private_dot_claude/sandbox/`
  (deployed to `~/.claude/sandbox/`) — a containerized Claude Code with its **own**
  `settings.base.json`, `sandbox-CLAUDE.md`, and entrypoint. Unrelated to the OS-sandbox
  block above; editing one does not affect the other.
