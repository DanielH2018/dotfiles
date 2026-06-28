# chezmoi Dotfiles Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the flat `dotfiles` repo into chezmoi source format with per-machine templating, install the `claude-permission-audit` plugin as shared config, and apply it on the Linux server — without harming the server's existing setup and behavior-preserving on the Work Mac.

**Architecture:** A `.chezmoiroot` file points chezmoi at a `home/` subdir (so `docs/`, `tests/`, `README.md` stay undeployed). Files become chezmoi source entries (`dot_*`, `private_dot_claude/`); machine-divergent ones become Go templates gated on `.chezmoi.os` (macOS-only) and a prompted `work` boolean (work-only). The global `~/.claude/settings.json` is *merged* (not overwritten) via a node `modify_` script that injects only the plugin marketplace + enablement.

**Tech Stack:** chezmoi (Go templates), zsh, git config, node (modify-script + its test), bash (server bring-up).

## Global Constraints

- All work happens in the clone at `…/scratchpad/dotfiles` on branch `feat/chezmoi` (already created; spec committed at `25a4d7f`).
- **Behavior-preserving on macOS:** every template's `darwin`/`work` branch must reproduce today's file content (semantically — git/shell don't care about section order). The Work Mac is validated by the user later; do not assume it can be tested here.
- **chezmoi source root is `home/`** (via `.chezmoiroot`). All deployable entries go under `home/`. Non-deployed repo files (`docs/`, `tests/`, `README.md`, repo `.gitignore`) stay at top level.
- **Machine facts:** `.chezmoi.os` ∈ {darwin, linux, windows} (auto); `work` = bool prompted once via `promptBoolOnce`.
- **Gating convention:** macOS-only-not-work → `{{ if eq .chezmoi.os "darwin" }}`; work-only → `{{ if .work }}`.
- **Plugin identity (exact strings):** marketplace name `daniel-tools`, source `github` repo `DanielH2018/claude-permission-audit`; plugin key `claude-permission-audit@daniel-tools`.
- **Never overwrite `~/.claude/settings.json`** — merge only.
- chezmoi only manages `$HOME`; the homelab project config at `/home/ubuntu/server/.claude/` must never be touched by `chezmoi apply`.
- Commit author for dotfiles commits: `DanielH2018 <danielh.2018@gmail.com>`. End commit messages with the Claude co-author trailer.
- Do **not** push or merge until the user explicitly asks (final task gates on user approval).

---

### Task 1: Install chezmoi + scaffold the source repo

**Files:**
- Create: `.chezmoiroot` (repo root, content: `home`)
- Create: `.gitignore` (repo root — replaces the old `ignore *` allowlist)
- Create: `README.md` (repo root)
- Create: `home/.chezmoi.toml.tmpl`
- Create: `home/.chezmoiignore`

**Interfaces:**
- Produces: the `work` template variable (consumed by all later templates); the `home/` source root; the linux-exclusion list (`Brewfile`, `.config/ghostty`, `.claude/hooks`, `.claude/sandbox`).

- [ ] **Step 1: Install chezmoi to ~/.local/bin**

```bash
sh -c "$(curl -fsLS get.chezmoi.io)" -- -b "$HOME/.local/bin"
"$HOME/.local/bin/chezmoi" --version
```
Expected: prints a chezmoi version (e.g. `chezmoi version v2.x`).

- [ ] **Step 2: Create `.chezmoiroot`**

File `.chezmoiroot` (repo root):
```
home
```

- [ ] **Step 3: Replace the repo `.gitignore`**

Overwrite `.gitignore` (repo root) with a normal repo ignore (the old `ignore *` allowlist is obsolete under chezmoi):
```gitignore
# Repo housekeeping (chezmoi state lives in ~/.config/chezmoi, not here)
.DS_Store
*.swp
*.swo
```

- [ ] **Step 4: Create `home/.chezmoi.toml.tmpl` (prompts for `work`)**

File `home/.chezmoi.toml.tmpl`:
```
{{- $work := promptBoolOnce . "work" "Is this a work machine" -}}
[data]
    work = {{ $work }}
```

- [ ] **Step 5: Create `home/.chezmoiignore` (templated linux exclusions)**

File `home/.chezmoiignore`:
```
{{ if ne .chezmoi.os "darwin" }}
Brewfile
.config/ghostty
.claude/hooks
.claude/sandbox
{{ end }}
```

- [ ] **Step 6: Create `README.md`**

File `README.md` (repo root):
```markdown
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
```

- [ ] **Step 7: Verify scaffolding parses + prompt works**

Run:
```bash
cd …/scratchpad/dotfiles
chezmoi execute-template '{{ .chezmoi.os }}'
```
Expected: prints `linux`.

Run (confirm the data file template parses and applies the prompt):
```bash
printf 'false\n' | chezmoi --source "$PWD" execute-template --init --promptBool work=false '{{ .work }}'
```
Expected: prints `false` with no template error.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): scaffold source root, work prompt, linux exclusions"
```

---

### Task 2: Convert the portable, non-templated files

These files are identical on every machine (ghostty/Brewfile are macOS-only and excluded on linux via `.chezmoiignore` from Task 1).

**Files (git mv into `home/`):**
- `.tmux.conf` → `home/dot_tmux.conf` (edit: drop phone-access comment, keep superset)
- `.gitignore_global` → `home/dot_gitignore_global`
- `.config/starship.toml` → `home/dot_config/starship.toml`
- `.config/fastfetch/` → `home/dot_config/fastfetch/`
- `.config/ghostty/` → `home/dot_config/ghostty/` (macOS-only at apply time)
- `Brewfile` → `home/Brewfile` (macOS-only at apply time)

- [ ] **Step 1: Move the files preserving history**

```bash
cd …/scratchpad/dotfiles
mkdir -p home/dot_config
git mv .gitignore_global home/dot_gitignore_global
git mv .config/starship.toml home/dot_config/starship.toml
git mv .config/fastfetch home/dot_config/fastfetch
git mv .config/ghostty home/dot_config/ghostty
git mv Brewfile home/Brewfile
git mv .tmux.conf home/dot_tmux.conf
```

- [ ] **Step 2: Rewrite `home/dot_tmux.conf` (superset, no phone comment)**

Overwrite `home/dot_tmux.conf` with exactly:
```tmux
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
set -g mouse on
set -g history-limit 50000
set -g base-index 1
```

- [ ] **Step 3: Verify linux apply set (ghostty + Brewfile excluded)**

```bash
chezmoi --source "$PWD" managed | sort
```
Expected: includes `.tmux.conf`, `.gitignore_global`, `.config/starship.toml`, `.config/fastfetch/...`; does **NOT** include `Brewfile`, `.config/ghostty` (excluded on linux).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): port tmux/gitignore_global/starship/fastfetch/ghostty/Brewfile"
```

---

### Task 3: Convert `.zshrc` into a general/work/darwin template

The source already contains the full 382-line `.zshrc`. This task **moves** it to `home/dot_zshrc.tmpl` and **wraps specific blocks** in guards — preserving all original content for the Mac while keeping work/mac lines off the server. Do not delete any functional line; only wrap or split.

**Files:**
- `.zshrc` → `home/dot_zshrc.tmpl`

- [ ] **Step 1: Move the file**

```bash
cd …/scratchpad/dotfiles
git mv .zshrc home/dot_zshrc.tmpl
```

- [ ] **Step 2: Wrap the WORK-only blocks in `{{ if .work }} … {{ end }}`**

Apply to `home/dot_zshrc.tmpl`:
1. The `GRAFANA_URL` export (orig line 18).
2. The entire **AWS Configuration** section — from the `# === AWS Configuration ===` header through the `ec2ls` alias (orig lines ~220–281, includes `aws-sso-cleanup`, the `aws()` wrapper, `awslogin/awswho/awsp/awslogs`, the `bashcompinit`/`complete -C "$(command -v aws_completer)" aws` lines, and the `awsls`/`ec2ls` aliases).
3. The `vault` alias (orig line 178).
4. The entire **1Password CLI** section — `_op_load_keys`, `op-refresh-keys`, `_op_lazy_precmd`, the `add-zsh-hook precmd` line, and the `export SSH_AUTH_SOCK=...1password...` line (orig lines ~310–369).

- [ ] **Step 3: Wrap the macOS-only blocks in `{{ if eq .chezmoi.os "darwin" }} … {{ end }}`**

1. `export ARCHFLAGS="-arch $(uname -m)"` (orig line 24).
2. The Homebrew PATH manipulation + coreutils gnubin (orig lines ~47–55: the `[[ ":$PATH:" != …$BREW_PREFIX/bin… ]]` ensure and the `coreutils/libexec/gnubin` block). Keep the `BREW_PREFIX=` definition + `HOMEBREW_NO_ENV_HINTS` (orig 9–10) where it is so later refs resolve.
3. The hardcoded brew python path — **split** orig line 52 `export PATH="/opt/homebrew/opt/python@3.14/libexec/bin:$HOME/go/bin:$PATH"` into:
   - general (always): `[[ -d "$HOME/go/bin" ]] && export PATH="$HOME/go/bin:$PATH"`
   - darwin-only: `export PATH="/opt/homebrew/opt/python@3.14/libexec/bin:$PATH"`
4. The `configterminal` alias referencing ghostty (orig line 172).
5. The Snowflake PATH line (orig line 377) and the Docker Desktop completions block (orig lines ~378–382, `/Users/daniel/.docker/completions` + the trailing `compinit`).

- [ ] **Step 4: Apply the improvements (must stay Mac-behavior-preserving)**

1. **Remove** the obsolete bare-repo alias (orig line 195): `alias dotfiles='git --git-dir=$HOME/.dotfiles --work-tree=$HOME'`.
2. **Path-agnostic zsh plugins** — replace the two `source "$BREW_PREFIX/share/zsh-*/..."` blocks (orig ~301–308) so they also find the Linux location. Use this form for each plugin:
```zsh
for _zp in \
  "$BREW_PREFIX/share/zsh-autosuggestions/zsh-autosuggestions.zsh" \
  /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh; do
  [[ -r "$_zp" ]] && { source "$_zp"; break; }
done
for _zp in \
  "$BREW_PREFIX/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh" \
  /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh; do
  [[ -r "$_zp" ]] && { source "$_zp"; break; }
done
unset _zp
```
3. **Path-agnostic fzf** — after the existing brew fzf `source` lines (orig ~141–143), the `[[ -f ~/.fzf.zsh ]] && source ~/.fzf.zsh` fallback already covers Linux (fzf's Debian package ships key-bindings under `/usr/share/doc/fzf/examples/`); add Linux key-binding sourcing:
```zsh
[[ -r /usr/share/doc/fzf/examples/key-bindings.zsh ]] && source /usr/share/doc/fzf/examples/key-bindings.zsh
[[ -r /usr/share/doc/fzf/examples/completion.zsh ]] && source /usr/share/doc/fzf/examples/completion.zsh
```

- [ ] **Step 5: Render on linux (work=false) and verify it's clean**

```bash
chezmoi --source "$PWD" execute-template --init --promptBool work=false < home/dot_zshrc.tmpl > /tmp/zshrc.linux
# No work/mac leakage:
grep -nE 'lithic|grafana|aws_completer|op://|SnowflakeCLI|/opt/homebrew/opt/python|op-ssh-sign|My_Vault|ARCHFLAGS' /tmp/zshrc.linux || echo "CLEAN: no work/mac lines"
# Valid zsh syntax:
zsh -n /tmp/zshrc.linux && echo "SYNTAX OK"
```
Expected: `CLEAN: no work/mac lines` and `SYNTAX OK`.

- [ ] **Step 6: Render the darwin+work branch and confirm nothing was lost**

```bash
# Render with work=true (still linux OS here, so darwin blocks won't expand) — used only to
# confirm work blocks are syntactically intact:
chezmoi --source "$PWD" execute-template --init --promptBool work=true < home/dot_zshrc.tmpl > /tmp/zshrc.work
zsh -n /tmp/zshrc.work && echo "WORK BRANCH SYNTAX OK"
# Confirm every original work/mac marker still exists somewhere in the template source:
for m in 'GRAFANA_URL' 'aws_completer' 'op-ssh-sign' 'SnowflakeCLI' 'python@3.14' 'ARCHFLAGS' 'My_Vault' '_op_load_keys'; do
  grep -q "$m" home/dot_zshrc.tmpl && echo "kept: $m" || echo "LOST: $m"
done
```
Expected: `WORK BRANCH SYNTAX OK` and every marker `kept:` (none `LOST:`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): template .zshrc — gate work/macOS blocks, add linux tool paths"
```

---

### Task 4: Convert `.zshenv`, `.zprofile`, `.bash_profile`

**Files:**
- `.zshenv` → `home/dot_zshenv`
- `.zprofile` → `home/dot_zprofile.tmpl`
- `.bash_profile` → `home/dot_bash_profile.tmpl`

- [ ] **Step 1: Move the files**

```bash
cd …/scratchpad/dotfiles
git mv .zshenv home/dot_zshenv
git mv .zprofile home/dot_zprofile.tmpl
git mv .bash_profile home/dot_bash_profile.tmpl
```

- [ ] **Step 2: Rewrite `home/dot_zshenv` (guard cargo)**

```sh
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
```

- [ ] **Step 3: Rewrite `home/dot_zprofile.tmpl` (macOS-only body)**

```
{{- if eq .chezmoi.os "darwin" -}}
# Homebrew — must run in login shells before .zshrc so HOMEBREW_PREFIX is set
# and /opt/homebrew/bin precedes /usr/bin in PATH.
eval "$(/opt/homebrew/bin/brew shellenv)"

# added by Snowflake SnowflakeCLI installer v1.0
export PATH=/Applications/SnowflakeCLI.app/Contents/MacOS/:$PATH
{{- end -}}
```

- [ ] **Step 4: Rewrite `home/dot_bash_profile.tmpl`**

```
export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
{{- if eq .chezmoi.os "darwin" }}

# added by Snowflake SnowflakeCLI installer v1.0
export PATH=/Applications/SnowflakeCLI.app/Contents/MacOS/:$PATH
{{- end }}
```

- [ ] **Step 5: Verify linux renders are clean**

```bash
chezmoi --source "$PWD" execute-template --init --promptBool work=false < home/dot_zprofile.tmpl > /tmp/zprofile.linux
test ! -s /tmp/zprofile.linux && echo "zprofile EMPTY on linux (correct)"
chezmoi --source "$PWD" execute-template --init --promptBool work=false < home/dot_bash_profile.tmpl > /tmp/bashprofile.linux
grep -q SnowflakeCLI /tmp/bashprofile.linux && echo "LEAK" || echo "bash_profile CLEAN on linux"
bash -n /tmp/bashprofile.linux && echo "SYNTAX OK"
```
Expected: `zprofile EMPTY on linux (correct)`, `bash_profile CLEAN on linux`, `SYNTAX OK`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): template zshenv/zprofile/bash_profile, gate brew+snowflake"
```

---

### Task 5: Convert `.gitconfig` into a template

Mac branch reproduces today's Mac gitconfig (incl. 1Password SSH signing). Linux branch uses the server's richer, signing-free config.

**Files:**
- `.gitconfig` → `home/dot_gitconfig.tmpl`

- [ ] **Step 1: Move the file**

```bash
cd …/scratchpad/dotfiles
git mv .gitconfig home/dot_gitconfig.tmpl
```

- [ ] **Step 2: Overwrite `home/dot_gitconfig.tmpl` with the templated config**

```
[user]
	name = {{ if .work }}Daniel Hunter{{ else }}DanielH2018{{ end }}
	email = danielh.2018@gmail.com
{{- if eq .chezmoi.os "darwin" }}
	signingkey = ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDA7LulgtoUwepzoMDD4UgAS1OD09qi4WvvJnDOUNkou
[gpg]
	format = ssh
[gpg "ssh"]
	program = /Applications/1Password.app/Contents/MacOS/op-ssh-sign
[commit]
	gpgsign = true
[core]
	excludesfile = ~/.gitignore_global
	autocrlf = input
{{- else }}
[credential]
	helper = store
[core]
	excludesfile = ~/.gitignore_global
	pager = less
{{- end }}
[pull]
	rebase = true
[push]
	autoSetupRemote = true
{{- if ne .chezmoi.os "darwin" }}
	default = simple
	followTags = true
{{- end }}
[fetch]
	prune = true
{{- if ne .chezmoi.os "darwin" }}
	pruneTags = true
	all = true
{{- end }}
[branch]
	sort = -committerdate
[rerere]
	enabled = true
{{- if ne .chezmoi.os "darwin" }}
	autoupdate = true
{{- end }}
[diff]
	colorMoved = {{ if eq .chezmoi.os "darwin" }}zebra{{ else }}plain{{ end }}
{{- if ne .chezmoi.os "darwin" }}
	algorithm = histogram
	mnemonicPrefix = true
	renames = true
	submodule = log
{{- end }}
[merge]
	conflictstyle = {{ if eq .chezmoi.os "darwin" }}zdiff3{{ else }}diff3{{ end }}
[init]
	defaultBranch = main
{{- if ne .chezmoi.os "darwin" }}
[commit]
	verbose = true
[tag]
	sort = version:refname
[rebase]
	autoSquash = true
	autoStash = true
	updateRefs = true
[column]
	ui = auto
[status]
	submoduleSummary = true
[submodule]
	recurse = true
[log]
	decorate = true
	abbrevCommit = true
[help]
	autocorrect = prompt
[alias]
	lg = log --oneline --graph --decorate --all
	lga = log --oneline --graph --decorate --all --date=relative
	lgb = log --oneline --graph --decorate --all --date=relative --branches
	lgc = log --oneline --graph --decorate --all --date=relative --branches --tags
[color]
	ui = auto
{{- end }}
```

- [ ] **Step 3: Verify both renders are valid git config**

```bash
chezmoi --source "$PWD" execute-template --init --promptBool work=false < home/dot_gitconfig.tmpl > /tmp/gc.linux
git config -f /tmp/gc.linux --list >/dev/null && echo "LINUX gitconfig valid"
grep -q op-ssh-sign /tmp/gc.linux && echo "LEAK signing" || echo "linux: no 1Password signing (correct)"
grep -q 'helper=store' <(git config -f /tmp/gc.linux --list) && echo "linux: credential helper present"
chezmoi --source "$PWD" execute-template --init --promptBool work=true < home/dot_gitconfig.tmpl > /tmp/gc.work
git config -f /tmp/gc.work --list >/dev/null && echo "WORK gitconfig valid"
```
Expected: `LINUX gitconfig valid`, `linux: no 1Password signing (correct)`, `linux: credential helper present`, `WORK gitconfig valid`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): template .gitconfig — macOS 1Password signing vs linux config"
```

---

### Task 6: Convert global `.claude/` — CLAUDE.md template + portable assets

**Files (git mv into `home/private_dot_claude/`):**
- `.claude/CLAUDE.md` → `home/private_dot_claude/CLAUDE.md.tmpl` (templated)
- `.claude/rules/` → `home/private_dot_claude/rules/`
- `.claude/commands/` → `home/private_dot_claude/commands/`
- `.claude/keybindings.json` → `home/private_dot_claude/keybindings.json`
- `.claude/statusline-command.sh` → `home/private_dot_claude/executable_statusline-command.sh`
- `.claude/hooks/` → `home/private_dot_claude/hooks/` (macOS-only via `.chezmoiignore`)
- `.claude/sandbox/` → `home/private_dot_claude/sandbox/` (macOS-only via `.chezmoiignore`)
- `.claude/settings.json`, `.claude/projects/` → **deleted from the new tree** (settings handled in Task 7; projects = per-machine memory, unmanaged)

- [ ] **Step 1: Move the tree, then relocate/rename pieces**

```bash
cd …/scratchpad/dotfiles
mkdir -p home/private_dot_claude
git mv .claude/rules home/private_dot_claude/rules
git mv .claude/commands home/private_dot_claude/commands
git mv .claude/keybindings.json home/private_dot_claude/keybindings.json
git mv .claude/statusline-command.sh home/private_dot_claude/executable_statusline-command.sh
git mv .claude/hooks home/private_dot_claude/hooks
git mv .claude/sandbox home/private_dot_claude/sandbox
git mv .claude/CLAUDE.md home/private_dot_claude/CLAUDE.md.tmpl
# Drop machine-specific / handled-elsewhere entries:
git rm -r .claude/settings.json .claude/projects
# Remove now-empty .claude if anything remains:
rmdir .claude 2>/dev/null || true
```

- [ ] **Step 2: Overwrite `home/private_dot_claude/CLAUDE.md.tmpl` (general baseline + gated work blocks, original order preserved)**

```
# Claude Code — User-level instructions
{{- if .work }}

## About me

I'm a software engineer on the **Processing team** at Lithic (card-issuing infrastructure / fintech).
I work across backend services, internal tooling, and occasionally frontend.
{{- end }}

## Communication style

- Be terse. No preamble, no trailing "here's what I did" summaries — I can read the diff.
- No emojis unless I ask.
- When referencing code, include `file:line` so I can jump to it.
- If something is ambiguous, ask one focused question rather than listing all possibilities.

## Git conventions
{{- if eq .chezmoi.os "darwin" }}

- Commits are signed via 1Password SSH agent — never pass `--no-verify` or any flag that bypasses signing.
{{- end }}
- Default branch is `main`. Prefer rebase over merge.
- Always create a new commit rather than amending unless I explicitly ask to amend.
- Write commit messages that explain *why*, not just what changed.
{{- if .work }}

## Environment

- macOS, zsh, vim
- Node managed via fnm (not Homebrew) — don't suggest `brew install node`
- Java managed via sdkman — don't suggest `brew install java`
- SSH keys managed through 1Password

@~/.claude/docs/integrations.md

## Model routing

Use the **planner** agent (Opus) for design decisions, architecture analysis, and implementation planning.
Use the **implementer** agent (Sonnet) for writing code, fixing bugs, and executing plans.
For straightforward single-file edits, handle inline without delegating.

## Domain context

This is a financial infrastructure environment. Be conservative with anything touching
auth, secrets, cryptography, or data access. Flag suggestions that could be relevant to
PCI-DSS or SOC 2 compliance rather than assuming they're fine.
{{- end }}

## Testing

Write tests for any new code I create. Match the style and framework already used in the project.

## What I don't want

- Don't add docstrings, comments, or type annotations to code you didn't change.
- Don't refactor or "clean up" code beyond what the task requires.
- Don't add error handling for scenarios that can't happen.
- Don't create new files when editing an existing one would do.

## Compaction policy

When compacting, always preserve:
- The full list of files modified in this session
- All test commands run and their pass/fail results
- Any user corrections or architectural decisions
- Current task state and next steps
- Active branch name and whether changes are pushed
{{- if .work }}

@~/.claude/docs/enforcement.md
{{- end }}
```

- [ ] **Step 3: Verify CLAUDE.md renders + linux apply set**

```bash
chezmoi --source "$PWD" execute-template --init --promptBool work=false < home/private_dot_claude/CLAUDE.md.tmpl > /tmp/claude.linux
grep -nE 'Lithic|PCI-DSS|planner|@~/.claude/docs' /tmp/claude.linux && echo "LEAK" || echo "linux CLAUDE.md CLEAN"
chezmoi --source "$PWD" managed | grep -E '\.claude/(hooks|sandbox)' && echo "UNEXPECTED hooks/sandbox in linux set" || echo "hooks/sandbox excluded on linux (correct)"
chezmoi --source "$PWD" managed | grep -E '\.claude/rules' && echo "rules managed (correct)"
```
Expected: `linux CLAUDE.md CLEAN`, `hooks/sandbox excluded on linux (correct)`, `rules managed (correct)`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): template global CLAUDE.md, port rules/commands/statusline/keybindings"
```

---

### Task 7: `settings.json` merge modify-script + node test (TDD)

**Files:**
- Create: `home/private_dot_claude/modify_settings.json` (node, executable, shebang)
- Test: `tests/modify_settings.test.js` (top-level, not deployed)

**Interfaces:**
- Produces: a chezmoi modify-script that, given the current `~/.claude/settings.json` on stdin (possibly empty), emits JSON with `extraKnownMarketplaces["daniel-tools"]` and `enabledPlugins["claude-permission-audit@daniel-tools"]=true` added, all other keys preserved; idempotent; unparseable input echoed unchanged.

- [ ] **Step 1: Write the failing test**

File `tests/modify_settings.test.js`:
```js
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'home', 'private_dot_claude', 'modify_settings.json');
const run = (input) => execFileSync('node', [SCRIPT], { input, encoding: 'utf8' });

// 1. Empty input (new machine) -> creates both keys.
let out = JSON.parse(run(''));
assert.strictEqual(out.enabledPlugins['claude-permission-audit@daniel-tools'], true);
assert.deepStrictEqual(out.extraKnownMarketplaces['daniel-tools'].source,
  { source: 'github', repo: 'DanielH2018/claude-permission-audit' });

// 2. Existing keys preserved, additions made.
const existing = JSON.stringify({ model: 'opus', enabledPlugins: { 'foo@bar': true } });
out = JSON.parse(run(existing));
assert.strictEqual(out.model, 'opus');
assert.strictEqual(out.enabledPlugins['foo@bar'], true);
assert.strictEqual(out.enabledPlugins['claude-permission-audit@daniel-tools'], true);

// 3. Idempotent: running twice yields identical output.
const once = run(existing);
const twice = run(once);
assert.strictEqual(once, twice);

// 4. Unparseable input is echoed unchanged (never destroy a file we can't parse).
const junk = '{ this is not json';
assert.strictEqual(run(junk), junk);

console.log('ALL PASS');
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node tests/modify_settings.test.js`
Expected: FAIL (script does not exist yet — `ENOENT`).

- [ ] **Step 3: Write the modify-script**

File `home/private_dot_claude/modify_settings.json`:
```js
#!/usr/bin/env node
// chezmoi modify_ script: merge the permission-audit plugin into ~/.claude/settings.json
// WITHOUT disturbing any other key. Current file content arrives on stdin (empty if the
// file does not exist yet); the new content is written to stdout.
const fs = require('node:fs');
const MARKETPLACE = 'daniel-tools';
const PLUGIN = 'claude-permission-audit@daniel-tools';

const input = fs.readFileSync(0, 'utf8');
let cfg;
try {
  cfg = input.trim() ? JSON.parse(input) : {};
} catch (e) {
  // Don't destroy a file we can't parse — emit it unchanged.
  process.stdout.write(input);
  process.exit(0);
}

cfg.extraKnownMarketplaces = cfg.extraKnownMarketplaces || {};
if (!cfg.extraKnownMarketplaces[MARKETPLACE]) {
  cfg.extraKnownMarketplaces[MARKETPLACE] = {
    source: { source: 'github', repo: 'DanielH2018/claude-permission-audit' },
  };
}
cfg.enabledPlugins = cfg.enabledPlugins || {};
cfg.enabledPlugins[PLUGIN] = true;

process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
```

- [ ] **Step 4: Make it executable + run the test**

```bash
chmod +x home/private_dot_claude/modify_settings.json
node tests/modify_settings.test.js
```
Expected: `ALL PASS`.

- [ ] **Step 5: Verify chezmoi recognizes it as a modify-script (not a regular file)**

```bash
chezmoi --source "$PWD" managed | grep '\.claude/settings.json' && echo "settings.json is managed (via modify_)"
chezmoi --source "$PWD" cat ~/.claude/settings.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.enabledPlugins["claude-permission-audit@daniel-tools"]&&j.extraKnownMarketplaces["daniel-tools"])console.log("MERGE OK (applied to live settings preview)");else{console.log("MERGE MISSING");process.exit(1)}})'
```
Expected: `settings.json is managed (via modify_)` and `MERGE OK …` (this renders the modify-script against the *actual* current `~/.claude/settings.json`, proving the merge preserves existing keys + adds the plugin).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(chezmoi): add settings.json merge modify-script (plugin enable) + node test"
```

---

### Task 8: Apply on the server + verify (real linux)

No git commit (this changes live `$HOME`). Back up real collisions first; `settings.json` is merged so it is not at risk.

- [ ] **Step 1: Back up the two real collisions**

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp -av ~/.gitconfig ~/.gitconfig.pre-chezmoi.$ts
cp -av ~/.tmux.conf ~/.tmux.conf.pre-chezmoi.$ts
cp -av ~/.claude/settings.json ~/.claude/settings.json.pre-chezmoi.$ts
```

- [ ] **Step 2: Point chezmoi at the branch clone + init (work=false)**

```bash
chezmoi init --source "…/scratchpad/dotfiles" --promptBool work=false
```
Expected: completes; `chezmoi data | grep -A2 '"work"'` shows `false`.

- [ ] **Step 3: Preview the full diff**

```bash
chezmoi diff
```
Expected: shows new/updated `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.bash_profile`, `~/.gitconfig`, `~/.tmux.conf`, `~/.gitignore_global`, `~/.config/starship.toml`, `~/.config/fastfetch/*`, `~/.claude/CLAUDE.md`, `~/.claude/rules/*`, `~/.claude/commands/*`, `~/.claude/keybindings.json`, `~/.claude/statusline-command.sh`; and for `~/.claude/settings.json` ONLY the additive marketplace + enabledPlugins lines. **No** ghostty/Brewfile/hooks/sandbox.

- [ ] **Step 4: Apply**

```bash
chezmoi apply -v
```

- [ ] **Step 5: Verify settings.json merged (original keys intact)**

```bash
node -e 'const j=require(process.env.HOME+"/.claude/settings.json");
console.log("model:", j.model, "| theme:", j.theme, "| footerLinks?", !!j.footerLinksRegexes,
  "| plugin:", j.enabledPlugins["claude-permission-audit@daniel-tools"],
  "| marketplace:", !!j.extraKnownMarketplaces["daniel-tools"]);'
```
Expected: original `model`/`theme`/`footerLinks` still present **and** plugin/marketplace added.

- [ ] **Step 6: Verify idempotency + git/tmux**

```bash
chezmoi apply -v && chezmoi diff
git config --get user.email
tmux -f ~/.tmux.conf new -d -s _t 'sleep 1' 2>/dev/null && echo "tmux config OK" || true
```
Expected: second apply makes no changes; `chezmoi diff` empty; email correct; `tmux config OK`.

---

### Task 9: Install zsh + tools + chsh + interactive verification

No git commit (system packages). Use apt; install the tools the `.zshrc` uses.

- [ ] **Step 1: Ensure the en_US.UTF-8 locale exists**

```bash
locale -a | grep -qi 'en_US.utf8' || sudo locale-gen en_US.UTF-8
```

- [ ] **Step 2: Install zsh + tools**

```bash
sudo apt-get update
sudo apt-get install -y zsh fzf zoxide eza fastfetch
# starship + eza/zoxide fallbacks if apt lacks them (Ubuntu < 24.04):
command -v starship >/dev/null || sh -c "$(curl -fsSL https://starship.rs/install.sh)" -- -y
command -v eza >/dev/null || echo "NOTE: eza not in apt — .zshrc falls back to ls aliases (OK)"
command -v zoxide >/dev/null || curl -sS https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | bash
```
Expected: `zsh`, `fzf`, `starship`, `zoxide` resolve via `command -v`; `eza`/`fastfetch` optional (configs degrade).

- [ ] **Step 3: Make zsh the login shell**

```bash
chsh -s "$(command -v zsh)"
getent passwd "$USER" | cut -d: -f7
```
Expected: prints the zsh path. (Reversible: `chsh -s /bin/bash`.)

- [ ] **Step 4: Verify zsh loads cleanly with no work noise**

```bash
zsh -i -c 'echo LOADED; command -v starship >/dev/null && echo starship-active; command -v zoxide >/dev/null && echo zoxide-active' 2>/tmp/zsh.err
echo "--- stderr ---"; cat /tmp/zsh.err
grep -iE 'op://|aws_completer|lithic|/opt/homebrew|SnowflakeCLI|no such file' /tmp/zsh.err && echo "UNEXPECTED ERRORS" || echo "NO WORK/MAC ERRORS"
```
Expected: `LOADED`, `starship-active`, `zoxide-active`; stderr free of work/mac errors → `NO WORK/MAC ERRORS`.

---

### Task 10: Enable plugin globally (server) + disable on the homelab repo + verify

The global enable already happened via the modify-script in Task 8. This task verifies the plugin actually resolves, then prevents double-logging on the homelab repo. This is the one task that commits to the **homelab repo** (`/home/ubuntu/server`, branch `master`).

**Files:**
- Modify: `/home/ubuntu/server/.claude/settings.json` (add project-scope plugin disable)

- [ ] **Step 1: Verify the plugin marketplace/plugin resolves from the private repo**

```bash
cd ~   # a non-homelab dir so the homelab project settings don't apply
claude plugin list 2>/dev/null | grep -i permission-audit || echo "CHECK: confirm via /plugin in an interactive session"
```
Expected: the plugin appears installed/enabled. (If CLI subcommand differs, confirm in an interactive `claude` session with `/plugin`.) Confirms private-repo fetch works with existing GitHub auth.

- [ ] **Step 2: Confirm the collision exists on the homelab repo (baseline)**

```bash
cd /home/ubuntu/server
ls -la .claude/logs/permissions.json   # the Python logger's file
```
Expected: file exists (Python logger active here).

- [ ] **Step 3: Add a project-scope plugin disable to the homelab settings**

In `/home/ubuntu/server/.claude/settings.json`, add (merge into existing JSON, do not remove keys):
```json
"enabledPlugins": {
  "claude-permission-audit@daniel-tools": false
}
```
(If an `enabledPlugins` block already exists, add the single key to it.)

- [ ] **Step 4: VERIFY the project-scope disable actually works (open item from spec)**

```bash
cd /home/ubuntu/server
# Inspect the merged/effective plugin state for this project.
claude plugin list 2>/dev/null | grep -i permission-audit
```
Expected: shows the plugin **disabled** for this project while still enabled globally (Step 1).
**If the disable does NOT take effect (fallback):** remove the global enable instead — edit `home/private_dot_claude/modify_settings.json` to enable the plugin only when not on this host, OR drop the global enable and document that the plugin is for Mac/Windows; re-apply chezmoi. Record which path was taken in `docs/chezmoi-migration-design.md` (Open items section).

- [ ] **Step 5: Confirm no double-logging**

```bash
cd /home/ubuntu/server
# Trigger a benign tool call in an interactive claude session, then confirm the log format
# is still the Python single-format (not appended-to by the JS logger).
python3 -c "import json;d=json.load(open('.claude/logs/permissions.json'));print('python-format keys:', sorted(d.keys())[:5])"
```
Expected: the log parses as the Python format; no plugin (JS) entries interleaved.

- [ ] **Step 6: Commit (homelab repo, master)**

```bash
cd /home/ubuntu/server
git add .claude/settings.json
git commit -m "chore(claude): disable permission-audit plugin on this repo (keep Python auditing)

The portable claude-permission-audit plugin is enabled globally via dotfiles, but
this repo keeps its richer Python logger/audit. Disable the plugin here to avoid
double-logging to the same permissions.json.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11 (follow-up, separate scope): port useful Python-analyzer features into the plugin

Out of scope for the dotfiles branch; tracked here so it isn't lost. Do **not** block dotfiles work on this.

- Compare `/home/ubuntu/server/.claude/scripts/audit-permissions.py` against the plugin's `scripts/audit-permissions.js` (in `DanielH2018/claude-permission-audit`).
- Candidate features to port if missing from the JS version: dead-rule detection, hook-covered rule detection, redundant/subsumed rule pruning, the prompt-rate / per-tool split report.
- Deliver as a separate branch + PR on the `claude-permission-audit` repo with its own tests (the repo already has `scripts/audit-permissions.test.js` to extend).

---

### Task 12: Push the branch + Mac validation handoff (gated on user approval)

- [ ] **Step 1: Final local review**

```bash
cd …/scratchpad/dotfiles
git log --oneline main..feat/chezmoi
chezmoi --source "$PWD" diff   # should be empty after Task 8 apply (idempotent)
```

- [ ] **Step 2: Ask the user before pushing (outward-facing)**

Confirm with the user, then:
```bash
git push -u origin feat/chezmoi
```

- [ ] **Step 3: Provide the Mac validation checklist**

On the Work Mac, in a throwaway location:
```bash
chezmoi init DanielH2018/dotfiles   # checks out the branch's source; answer work=true
git -C "$(chezmoi source-path)" checkout feat/chezmoi
chezmoi diff                         # MUST be empty/near-empty — proves behavior-preserving
```
Expected on Mac: `chezmoi diff` shows **only** the additive `~/.claude/settings.json` plugin lines (and nothing else), confirming the conversion reproduces the Mac's current files. Then merge `feat/chezmoi` → `main`.

---

## Self-Review

**1. Spec coverage:**
- chezmoi adoption on a branch → Tasks 1–7. ✓
- Behavior-preserving on macOS → darwin/work branches in Tasks 3–6; Mac validation in Task 12. ✓
- Don't harm the server (homelab project untouched; backups; merge-not-overwrite) → Task 8 (backups, merge verify), Global Constraints. ✓
- General-vs-work shell split → Task 3. ✓
- settings.json merge → Task 7. ✓
- Global CLAUDE.md general/work split → Task 6. ✓
- Plugin global install + homelab disable + no double-log → Tasks 7–8 (enable) + 10 (disable/verify). ✓
- Plugin improvement follow-up → Task 11. ✓
- Server bring-up (zsh + tools) → Task 9. ✓
- `.chezmoiignore` Mac/work exclusions → Task 1. ✓
- Open items (project disable; private-repo fetch; locale) → Tasks 10, 10, 9. ✓

**2. Placeholder scan:** No TBD/TODO; all code blocks complete; transformation steps reference exact original line ranges + show the new/added code. ✓

**3. Type/name consistency:** marketplace `daniel-tools`, plugin `claude-permission-audit@daniel-tools`, repo `DanielH2018/claude-permission-audit`, var `work`, source root `home/` — used identically across Tasks 1, 5, 6, 7, 8, 10. ✓
