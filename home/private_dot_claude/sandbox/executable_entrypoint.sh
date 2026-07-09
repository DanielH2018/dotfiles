#!/bin/bash
set -euo pipefail

# Entrypoint for claudebot container.
# Runs as claudebot (UID 1000, supplementary GID 0 via --group-add 0).
# Syncs managed files from image defaults, appends dynamic environment
# context to CLAUDE.md, then launches Claude Code.

# --- npm supply-chain hardening (runtime, in-session installs) ---
# ignore-scripts blocks install-time lifecycle scripts (postinstall is the most
# common malicious-package RCE vector); fund silences the funding nag. These
# apply to `npm install` the agent runs in /workspace — the image's own trusted
# global installs already ran at build time. Override per-need with
# `npm install --ignore-scripts=false`. Note: npm has no rolling
# "minimum release age" knob (that is a pnpm feature), so we rely on
# ignore-scripts here plus `audit` (already enabled in settings.base.json).
export NPM_CONFIG_IGNORE_SCRIPTS=true
export NPM_CONFIG_FUND=false

# --- Sync managed files into persistent state volume ---
# The persistent volume at ~/.claude/ starts empty. Managed files (settings,
# hooks, CLAUDE.md) are bind-mounted into ~/.claude-defaults/ at runtime and
# force-copied here so edits take effect without rebuilding the image.
# Non-managed files (auth state, history) in the volume are left untouched.
DEFAULTS_DIR="/home/claudebot/.claude-defaults"
CLAUDE_DIR="/home/claudebot/.claude"

if [[ -d "$DEFAULTS_DIR" ]]; then
  mkdir -p "$CLAUDE_DIR/hooks"
  # Use if/then instead of && to avoid set -e exiting when the test is false
  if [[ -f "$DEFAULTS_DIR/settings.json" ]]; then
    cp -f "$DEFAULTS_DIR/settings.json" "$CLAUDE_DIR/settings.json"
  fi
  if [[ -f "$DEFAULTS_DIR/CLAUDE.md" ]]; then
    cp -f "$DEFAULTS_DIR/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  fi
  # Copy every bind-mounted hook script into the live hooks dir (audit.sh,
  # suggest-artifact.sh, and any future ones) so edits take effect on restart.
  if [[ -d "$DEFAULTS_DIR/hooks" ]]; then
    for _hook in "$DEFAULTS_DIR"/hooks/*.sh; do
      [[ -f "$_hook" ]] || continue
      cp -f "$_hook" "$CLAUDE_DIR/hooks/$(basename "$_hook")"
      chmod +x "$CLAUDE_DIR/hooks/$(basename "$_hook")"
    done
  fi
  if [[ -f "$DEFAULTS_DIR/statusline-command.sh" ]]; then
    cp -f "$DEFAULTS_DIR/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh"
  fi
fi

# --- Consolidate artifacts onto the /artifacts bind-mount ---
# Some skills (artifact-design, review flows) hardcode ~/.claude/artifacts. In the
# container that's the shared state volume, not the per-instance /artifacts mount the
# launcher tracks and gc-manages. Symlink it so those writes land in /artifacts
# (host-visible, instance-scoped, clickable via link-artifact.sh's symlink resolve).
# Loss-safe: migrate with mv -n; only replace the dir with a symlink once it's empty;
# if any file can't move, leave the real dir (link-artifact still resolves it).
if [[ -d /artifacts ]]; then
  if [[ -L "$CLAUDE_DIR/artifacts" ]]; then
    ln -sfn /artifacts "$CLAUDE_DIR/artifacts"
  elif [[ -d "$CLAUDE_DIR/artifacts" ]]; then
    ( shopt -s dotglob nullglob
      for _f in "$CLAUDE_DIR"/artifacts/*; do mv -n "$_f" /artifacts/ 2>/dev/null || true; done ) || true
    if rmdir "$CLAUDE_DIR/artifacts" 2>/dev/null; then
      ln -sfn /artifacts "$CLAUDE_DIR/artifacts"
    fi
  else
    ln -sfn /artifacts "$CLAUDE_DIR/artifacts"
  fi
fi

# --- Plugins ---
# Host plugins are bind-mounted read-only at ~/.claude/plugins/ (nested
# mount inside the state volume). Plugin installation must happen on the host.
#
# installed_plugins.json contains absolute macOS paths (e.g.
# /Users/<user>/.claude/plugins/...). A second Docker bind mount at the
# host path (read-only) makes those paths resolve inside the container.

# --- GitHub CLI config ---
# The host mounts hosts.yml read-only at a staging path. gh needs to write
# to its config dir (migration step on every invocation), so we copy to a
# writable location and point GH_CONFIG_DIR there. The token stays out of
# environment variables — only gh reads the file.
GH_STAGING="/home/claudebot/.gh-staging/hosts.yml"
if [[ -f "$GH_STAGING" ]]; then
  GH_CONFIG_DIR="/home/claudebot/.config/gh"
  mkdir -p "$GH_CONFIG_DIR"
  cp -f "$GH_STAGING" "$GH_CONFIG_DIR/hosts.yml"
  chmod 600 "$GH_CONFIG_DIR/hosts.yml"
  export GH_CONFIG_DIR
fi

# --- Append dynamic environment context to CLAUDE.md ---
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"

{
  echo ""
  echo "---"
  echo ""

  # Repo name
  if [[ -n "${SANDBOX_REPO_NAME:-}" ]]; then
    echo "- **Repository**: \`${SANDBOX_REPO_NAME}\`"
  fi

  # Worktree / branch
  if [[ -n "${SANDBOX_BRANCH:-}" ]]; then
    echo "- **Branch**: \`${SANDBOX_BRANCH}\` (git worktree — isolated from the main checkout)"
  fi

  # Detected toolchains
  if [[ -n "${SANDBOX_TOOLCHAINS:-}" ]]; then
    echo "- **Toolchains installed**: ${SANDBOX_TOOLCHAINS}"
  else
    echo "- **Toolchains installed**: base only (git, node, gh, make, chezmoi)"
  fi

  # Docker access
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    echo "- **Docker**: available via socket proxy (\`DOCKER_HOST=${DOCKER_HOST}\`). Exec, build, commit, and system calls are blocked by the proxy."
  else
    echo "- **Docker**: not available in this session"
  fi

  # GitHub auth (token delivered via gh config file, not env var)
  if [[ -f "${GH_CONFIG_DIR:-/home/claudebot/.config/gh}/hosts.yml" ]]; then
    echo "- **GitHub**: \`gh\` CLI authenticated (read-only — write ops denied). Token is in gh config, not in environment."
  else
    echo "- **GitHub**: not authenticated — \`gh\` CLI will not work"
  fi

  # Commit signing (1Password key via the forwarded agent socket)
  if command -v ssh-add >/dev/null && [[ -S "${SSH_AUTH_SOCK:-}" ]]; then
    _sign_key="$(git config --get user.signingkey 2>/dev/null | awk '{print $2}')"
    if [[ -n "$_sign_key" ]] && ssh-add -L 2>/dev/null | grep -qF "$_sign_key"; then
      echo "- **Commit signing**: 1Password key reachable via the forwarded agent — commits will sign."
    else
      echo "- **Commit signing**: signing key NOT reachable — \`commit.gpgsign\` is on, so \`git commit\` will fail. Unlock 1Password on the host (approve the prompt, or run \`op-ssh-ensure\` there)."
    fi
  fi

  # Plugins
  if [[ -d /home/claudebot/.claude/plugins/marketplaces ]]; then
    echo "- **Plugins**: mounted read-only from host."
  else
    echo "- **Plugins**: not available (plugins directory not mounted)"
  fi

  # Cloud MCPs
  echo "- **Cloud MCPs**: write operations denied (Atlassian, Slack, Notion, Gmail, Drive, Calendar, and any configured org MCPs). Read-only access only if authenticated."

  # Artifacts
  echo "- **Artifacts**: write non-git output (reports, exports, generated files) to \`/artifacts\` — bind-mounted to a host directory outside the repo, printed in the launcher's startup/exit banner."

  # Knowledge vault (curated, read-only) — pointer only; content is on-demand
  if [[ -n "${SANDBOX_VAULT_DIR:-}" ]]; then
    echo "- **Knowledge vault**: a read-only, curated subset of the Lithic vault is mounted at \`${SANDBOX_VAULT_DIR}\`. It is a reference to pull from **on demand — not preloaded**. Start at \`${SANDBOX_VAULT_DIR}/index.md\` (one line per page: service/repo maps, glossary, network releases, runbooks) and read only the pages your task needs. It is read-only and **partial** — only cleared pages exist, so don't assume a referenced page is present. Your branch name usually encodes a PROC ticket — a good first filter."
  fi

  # Semantic search over the curated subset (offline; index covers only the pages above)
  if [[ -n "${SANDBOX_VAULT_DB:-}" ]]; then
    echo "- **Vault search**: the curated subset is indexed for semantic search. Run \`vault-search \"<natural-language query>\"\` (add \`-k N\` for more hits) to rank the most relevant pages by meaning + keyword — faster and better than grepping \`index.md\`. Results are \`path › heading\` snippets; open the cited page for full context. The index covers only the curated pages, so absence from results is not proof the vault lacks it."
  fi

  # Sibling repos (read-only) — pointer only; content is on-demand
  if [[ -n "${SANDBOX_REPOS_DIR:-}" ]]; then
    if [[ -n "${SANDBOX_REPOS_LIVE:-}" ]]; then
      echo "- **Sibling repos**: other local repos are mounted read-only under \`${SANDBOX_REPOS_DIR}/<name>\` at their **live working tree** (current branch — may include uncommitted or unmerged changes). Read them on demand for cross-repo context (interfaces, call sites, shared contracts); nothing here is preloaded."
    else
      echo "- **Sibling repos**: other local repos are mounted read-only under \`${SANDBOX_REPOS_DIR}/<name>\` at their **\`main\`/\`master\`** state — tracked files only, so no local edits, build artifacts, or unmerged feature branches. Read them on demand for cross-repo context (interfaces, call sites, shared contracts); nothing here is preloaded. The snapshot reflects the last local fetch, so it can trail the true remote main."
    fi
  fi

  # chezmoi (dotfiles) — source is bind-mounted; in-container is preview/manage only
  if [[ -n "${CHEZMOI_SOURCE_DIR:-}" ]]; then
    echo "- **chezmoi**: the dotfiles SOURCE is bind-mounted read-write at \`${CHEZMOI_SOURCE_DIR}\`, and \`chezmoi\` is pointed at it. Inspect/preview/edit the source freely — \`chezmoi cat <target>\`, \`chezmoi diff\`, \`chezmoi managed\`, \`chezmoi source-path <file>\`, \`chezmoi execute-template\`, or edit source files directly (all git-tracked, so revertible). Do NOT run \`apply\`/\`update\`/\`init\` (they overwrite THIS container's home — a shared volume, not your host) or \`destroy\`/\`purge\` (they delete, and via the mount can reach your host source). Run \`chezmoi apply\` on the host after reviewing the diff."
  fi

} >> "$CLAUDE_MD"

exec "$@"
