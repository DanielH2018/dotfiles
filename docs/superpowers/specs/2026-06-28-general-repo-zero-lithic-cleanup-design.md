# General-repo zero-Lithic cleanup — design

**Status:** approved (2026-06-28)

## Goal

Remove all Lithic/work-specific references from the **general** dotfiles repo
(`DanielH2018/dotfiles`, chezmoi source at `~/.local/share/chezmoi`) so it stays
work-agnostic, while preserving the behaviour those references provided on the work
laptop by relocating them to the private work repo (`~/work-laptop-config`) behind the
same extension-point pattern the two-repo split already uses.

**Acceptance:** `grep -riE 'lithic|grafana|pagerduty|card.issu|my_vault' home/ --include='*'`
(excluding `home/docs/`) returns nothing in the general repo; `dotsync check` stays clean;
the Docker sandbox launches correctly **both** with and without the work overlay present;
work-laptop behaviour (vault hooks, sandbox work-MCP denies, capture-session command) is
unchanged after `~/work-laptop-config/install.sh` re-runs.

## Background

The two-repo split (see `2026-06-28-dotfiles-two-repo-split-design.md`) made the general
repo work-agnostic, with work specifics in `~/work-laptop-config` (a symlink farm) reached
through generic extension points: `~/.config/zsh/local.zsh`, `@~/.claude/CLAUDE.local.md`,
`~/.config/git/local.config`, and the `settings.json` base⊕overlay merge. A residual set of
Lithic/work-flavoured references remained in the general repo and was deferred. This cleans
them up. Decisions taken during brainstorming:

1. Vault-tied tooling is **work-specific**: move wholly-vault files; parameterize the vault
   path in shared hooks via an extension point.
2. Compliance/domain framing: scrub Lithic-specific wording to generic, but **keep**
   industry-standard PCI-DSS / SOC2 references.
3. The sandbox work-MCP deny rules **move to a work overlay** merged at sandbox launch.

`~/work-laptop-config/install.sh` symlinks each payload file individually (creating parent
dirs), so new files under `.claude/` and `.config/` deploy with a re-run. `dotsync`'s
`50-work.json` already declares roots `.claude` and `.config`, so new work-repo files become
owned targets automatically once committed.

## Components

### A. Vault-path extension point

A new optional file `~/.config/claude/local.env`, owned by the work repo and symlinked in,
exports machine/work-specific values for the general hooks. Initially one value:

```sh
CLAUDE_VAULT_DIR="$HOME/Documents/My_Vault"
```

General hooks source it defensively and treat the value as optional:

```sh
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
```

When `CLAUDE_VAULT_DIR` is unset/empty (personal machine), every vault-specific branch is
skipped — the hooks behave as generic, vault-unaware tools.

### B. Shared-hook parameterization (general repo)

- **`hooks/auto-format.sh`** (`:29`): the markdown skip-branch matches `"$CLAUDE_VAULT_DIR"/*`
  only when `CLAUDE_VAULT_DIR` is non-empty; the hardcoded `*/My_Vault/*` case is removed.
  Unset → all markdown is formatted normally.
- **`hooks/check-before-stop.sh`** (`:21`, `:24–28`, `:33`): **delete** the dead
  `$HOME/.dotfiles` toplevel exemption and the entire bare-repo `GIT_DIR` block (the bare repo
  was retired). Exempt `$CLAUDE_VAULT_DIR` (when set) at the toplevel `case`. Keep the generic
  `*dotfiles*` remote-URL match (covers the user's own chezmoi repo, which commits to main by
  convention); drop the `*My_Vault*` remote match in favour of the path exemption.
- **`hooks/watch-paths.sh`** (`:14`): watch `"$CLAUDE_VAULT_DIR"/raw` only when
  `CLAUDE_VAULT_DIR` is set; always watch `~/.claude/rules` as today.

### C. Sandbox session-log path (general repo)

- **`sandbox/executable_claude-sandbox`** (`:699`): `vault_dir` uses `$CLAUDE_VAULT_DIR/Work/
  Sessions/$repo_name` when `CLAUDE_VAULT_DIR` is set; otherwise falls back to a neutral
  `$HOME/.claude/sandbox-sessions/$repo_name`. The script sources `local.env` the same way as
  the hooks.

### D. Move `capture-session` to the work repo

`commands/capture-session.md` is wholly vault/work-domain (routes findings to
`Lithic/About Lithic.md`, `Team/Processing Team.md`, PagerDuty patterns) and cannot be
genericized. Move it verbatim to the work repo at `.claude/commands/capture-session.md`;
delete it from the general repo.

### E. Generic wording (PCI/SOC2 retained)

- **`agents/migration-reviewer.md`** (`:8`): replace "high-volume card-issuing platform … that
  process financial transactions" with neutral wording (e.g. "high-volume production platform …
  that processes critical data"). Keep the `### PCI/Compliance` section (`:29`) unchanged.
- **`sandbox/executable_entrypoint.sh`** (`:104`): in the report string, drop the named work
  vendors (Lithic, Grafana, PagerDuty) from the cloud-MCP list and add a generic "and any
  configured org MCPs" clause; keep the generic SaaS names (Atlassian, Slack, Notion, Gmail,
  Drive, Calendar) already present in the general base.
- **`hooks/executable_log-permission.test.js`** (`:182`): change the fixture path
  `C:/Users/daniel/My_Vault/.claude/scripts/check-links.js` to a neutral fixture path. Cosmetic;
  keeps the grep clean.
- **No change**: `workflows/security-sweep.js` and `hooks/executable_filter-test-output.sh`
  contain only PCI-DSS/SOC2/PAN wording, which is retained by decision 2.

### F. Sandbox settings base⊕overlay

- Rename `sandbox/settings.json` → `sandbox/settings.base.json`. Strip the work-MCP deny
  entries — PagerDuty (`mcp__claude_ai_Pagerduty__*`), Lithic
  (`mcp__claude_ai_Lithic_API_Docs__execute-request`,
  `mcp__claude_ai_Lithic_-_Stainless_-_Beta__execute`), and Grafana (`mcp__grafana__*`) — from
  the `permissions.deny` array, leaving valid JSON (the last remaining deny entry carries no
  trailing comma). Generic SaaS denies (Gmail, Calendar, Drive, Sentry, Privacy_MCP) stay.
- **`sandbox/executable_claude-sandbox`**: where it currently mounts `$SANDBOX_DIR/settings.json`
  (two mount points), resolve the file to mount once near the top: if
  `~/.config/claude/sandbox-settings.work.json` exists, merge base⊕overlay via the existing
  `claude-settings-merge` CLI (on `PATH` at `~/.local/bin/claude-settings-merge`) into a temp
  file (created under `${TMPDIR:-/tmp}`) and mount that; otherwise mount
  `$SANDBOX_DIR/settings.base.json` directly. Both existing mount lines reference the resolved
  path. If `claude-settings-merge` is missing or the merge fails, fall back to mounting the base
  and warn on stderr (never block sandbox launch).

### G. Work-repo additions

Add to `~/work-laptop-config`, deployed by `install.sh`:

- `.config/claude/local.env` — `CLAUDE_VAULT_DIR="$HOME/Documents/My_Vault"`.
- `.config/claude/sandbox-settings.work.json` — a settings fragment whose `permissions.deny`
  holds exactly the work-MCP deny entries removed from the general base (PagerDuty, Lithic,
  Grafana). Merged into the sandbox settings at launch by component F.
- `.claude/commands/capture-session.md` — the moved command from component D.

## dotsync / manifest impact

No manifest edits required: `00-general.json` derives general targets from `chezmoi managed`
(the moved/renamed files drop out automatically), and `50-work.json` already declares `.claude`
and `.config` roots so the three new work-repo files become owned targets once committed.
`RESTORE.md` already documents re-running `install.sh`; no checklist change needed beyond noting
the sandbox overlay if useful.

## Testing

- **Hook parameterization** (shell): for each of `auto-format.sh`, `check-before-stop.sh`,
  `watch-paths.sh`, assert behaviour with `CLAUDE_VAULT_DIR` set vs unset — vault branch honoured
  when set, fully skipped (generic behaviour) when unset. Drive each hook with representative
  stdin/JSON and a temp `HOME`/`local.env`.
- **check-before-stop dead-path removal**: assert the bare-repo `~/.dotfiles` logic is gone and
  the protected-branch staged/unstaged blocking still fires on `main`.
- **Sandbox merge selection** (`claude-sandbox`): unit-test the resolve-settings step in isolation
  — overlay present → merged file mounted (contains a work deny); overlay absent → base mounted;
  merge-tool failure → base mounted with a stderr warning. Do not launch Docker in tests.
- **settings.base.json validity**: assert it parses as JSON and contains no
  `lithic|grafana|pagerduty` entries.
- The merge algorithm itself is already covered by `claude-settings-merge` tests; do not duplicate.

## Out of scope / leave as-is

- `sandbox/Dockerfile.base` git identity (`danielh.2018@gmail.com` + signing key) — personal
  identity already present in the general `.gitconfig`; not Lithic.
- `commands/git-commit-and-push.md` — contains no work-specific references.
- Broader genericization of unrelated hardcoded `/Users/daniel` paths beyond the vault.

## Sequencing & safety

Branch off `main` in the general repo. Verify `dotsync check` is clean before starting. Make the
general-repo edits and the work-repo additions, `chezmoi apply`, re-run `install.sh`, then verify:
the grep acceptance check is clean; `dotsync check` is clean; the sandbox resolve-settings step
picks base when the overlay is absent and merged when present. Push both repos. The sandbox launch
path is the highest-risk change — the overlay-absent path must remain byte-for-byte equivalent to
mounting today's settings (minus the moved work denies).
