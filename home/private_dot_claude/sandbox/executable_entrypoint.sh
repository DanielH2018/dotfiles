#!/bin/bash
set -euo pipefail

# Entrypoint for claudebot container.
# Runs as claudebot (UID 1000, supplementary GID 0 via --group-add 0).
# Syncs managed files from image defaults, appends dynamic environment
# context to CLAUDE.md, then launches Claude Code.

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
  if [[ -f "$DEFAULTS_DIR/hooks/audit.sh" ]]; then
    cp -f "$DEFAULTS_DIR/hooks/audit.sh" "$CLAUDE_DIR/hooks/audit.sh"
    chmod +x "$CLAUDE_DIR/hooks/audit.sh"
  fi
  if [[ -f "$DEFAULTS_DIR/statusline-command.sh" ]]; then
    cp -f "$DEFAULTS_DIR/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh"
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
    echo "- **Toolchains installed**: base only (git, node, gh, make)"
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

  # Plugins
  if [[ -d /home/claudebot/.claude/plugins/marketplaces ]]; then
    echo "- **Plugins**: mounted read-only from host."
  else
    echo "- **Plugins**: not available (plugins directory not mounted)"
  fi

  # Cloud MCPs
  echo "- **Cloud MCPs**: write operations denied (Atlassian, Slack, Notion, Gmail, Drive, Calendar, PagerDuty, Lithic, Grafana). Read-only access only if authenticated."

} >> "$CLAUDE_MD"

exec "$@"
