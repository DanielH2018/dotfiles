#!/usr/bin/env bash
# sandbox-auth.sh — get credentials into the container, sourced by claude-sandbox
# (lives in ~/.claude/sandbox). Sourced, not executed: define functions only, never
# run anything at load time or set shell options here.
#
# Two unrelated-looking flows that are the same concern — the sandbox has no
# credentials of its own, and both of these hand it some:
#
#   configure_gh_auth      a GitHub token, staged into a mounted gh config file
#   run_oauth_if_needed    an Anthropic OAuth session for the cloud MCPs
#
# CONTRACT — both read and write launcher globals; neither is pure.
#
# configure_gh_auth reads GITHUB_TOKEN from the environment, APPENDS to DOCKER_ARGS,
# and sets two globals. GH_HOSTS_TMPFILE in particular must stay a global and must
# not be `local`: the launcher's cleanup() trap reads it to delete the staged token
# file on exit, so scoping it here would leak a 0600 file holding a live token on
# every run. GH_AUTH_METHOD is only read back inside this file, and is left global
# to keep the extraction a straight move.
#
# run_oauth_if_needed reads AUTH_MARKER, SHELL_MODE, EXEC_MODE, ENGINE_ARGS,
# STATE_DIR, SANDBOX_SETTINGS and IMAGE_TAG, sets AUTH_NEEDED, and calls
# add_mount_relabel(), which is defined in the launcher rather than here — this file
# is sourced, so that resolves at call time, but it does mean sandbox-auth.sh cannot
# be sourced on its own.
#
# Both print to stdout as they go. Their two call sites sit either side of the Docker
# proxy block in the launcher, and the interleaving is the launch banner the user
# reads — keep the calls where they are.

# --- GitHub CLI authentication (read-only access) ---
configure_gh_auth() {
  # Token is delivered via gh config file mounted read-only, NOT as an
  # environment variable. This prevents Python/Node subprocesses from
  # reading it via os.environ and bypassing the gh deny rules.
  GH_AUTH_METHOD=""
  GH_HOSTS_TMPFILE=""
  GH_TOKEN=""

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    GH_TOKEN="$GITHUB_TOKEN"
    GH_AUTH_METHOD="GITHUB_TOKEN"
  elif command -v gh &>/dev/null; then
    GH_TOKEN="$(gh auth token 2>/dev/null || true)"
    [[ -n "$GH_TOKEN" ]] && GH_AUTH_METHOD="host-keyring"
  fi

  if [[ -n "$GH_TOKEN" ]]; then
    GH_HOSTS_TMPFILE="$(mktemp "${TMPDIR:-/tmp}/gh-hosts-XXXXXX")"
    chmod 600 "$GH_HOSTS_TMPFILE"
    cat > "$GH_HOSTS_TMPFILE" <<GHEOF
github.com:
    oauth_token: ${GH_TOKEN}
    git_protocol: https
GHEOF
    unset GH_TOKEN
    DOCKER_ARGS+=(
      -v "$GH_HOSTS_TMPFILE:/home/claudebot/.gh-staging/hosts.yml:ro"
    )
    echo "  GitHub: authenticated via $GH_AUTH_METHOD (token in gh config, not env — write ops blocked)"
  else
    unset GH_TOKEN
    echo "  GitHub: no auth found — run 'gh auth login' on the host or set GITHUB_TOKEN"
  fi
}

# --- OAuth authentication for cloud MCPs ---
run_oauth_if_needed() {
  # Run as a separate short-lived container so it gets its own proper TTY.
  # The auth state persists in STATE_DIR (mounted at ~/.claude/).
  # Re-authenticate if the marker is missing or older than 30 days
  AUTH_NEEDED=false
  if [[ ! -f "$AUTH_MARKER" ]]; then
    AUTH_NEEDED=true
  elif find "$AUTH_MARKER" -mtime +30 -print -quit 2>/dev/null | grep -q .; then
    AUTH_NEEDED=true
    echo "OAuth session is >30 days old — re-authenticating."
  fi

  # A standalone bash shell doesn't need cloud MCP auth — don't force the OAuth prompt.
  [[ "$SHELL_MODE" == true ]] && AUTH_NEEDED=false
  # Headless --exec can't complete an interactive OAuth flow; skip it (base auth comes from
  # the mounted .credentials.json — cloud MCPs are simply unavailable to the implementer).
  [[ "$EXEC_MODE" == true ]] && AUTH_NEEDED=false

  if [[ "$AUTH_NEEDED" == true ]]; then
    echo "================================================"
    echo "  Cloud MCP authentication (one-time setup)"
    echo "================================================"
    echo ""
    echo "Cloud MCPs (Jira, Slack, Notion, Gmail, etc.) require"
    echo "an OAuth login with your Anthropic account."
    echo ""
    if docker run --rm -it \
      --init \
      --entrypoint "" \
      --cap-drop all \
      --security-opt no-new-privileges \
      ${ENGINE_ARGS[@]+"${ENGINE_ARGS[@]}"} \
      -v "$(add_mount_relabel "$STATE_DIR:/home/claudebot/.claude")" \
      -v "$(add_mount_relabel "$SANDBOX_SETTINGS:/home/claudebot/.claude/settings.json:ro")" \
      "$IMAGE_TAG" claude auth login; then
      touch "$AUTH_MARKER"
      echo ""
      echo "Authentication saved. Future launches will skip this step."
      echo "To re-authenticate: rm $AUTH_MARKER"
    else
      echo ""
      echo "Authentication skipped. Cloud MCPs won't be available this session."
    fi
    echo ""
  fi
}
