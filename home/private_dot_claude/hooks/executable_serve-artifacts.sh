#!/usr/bin/env bash
# SessionStart (Linux only — wired in .chezmoitemplates/settings.base.json under an
# `eq .chezmoi.os "linux"` guard): ensure a localhost static HTTP server is serving
# ~/.claude/artifacts, so the artifact links emitted as http://localhost:PORT/... by
# link-artifact.sh are click-to-render from a VS Code Remote-SSH terminal (VS Code
# auto-forwards the port over SSH). A file:// link can't work there — it resolves on
# the LOCAL client, which does not have the remote path.
#
# Idempotent + fast: no-op if the port is already served; otherwise it backgrounds the
# server in its own session (setsid) so it outlives this hook and the Claude session,
# and returns immediately so it never delays session start.
set -u

PORT="${CLAUDE_ARTIFACTS_PORT:-8181}"
DIR="$HOME/.claude/artifacts"
LOG="$HOME/.claude/.artifacts-server.log"

mkdir -p "$DIR"

# Already serving? -> nothing to do. Match the running server by its cmdline (pgrep
# excludes itself, and the hook's own cmdline contains no "http.server", so there is no
# self-match). Robust across shells/bash builds, unlike a /dev/tcp connect test.
if pgrep -f "http\.server ${PORT}( |$)" >/dev/null 2>&1; then
  exit 0
fi

command -v python3 >/dev/null 2>&1 || exit 0

# Bind to loopback only: reachable through the SSH tunnel / forwarded port, never the LAN.
setsid python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" \
  >"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true
exit 0
