#!/usr/bin/env bash
# SessionStart (Linux and macOS — wired in .chezmoitemplates/settings.base.json): ensure
# a loopback static HTTP server is serving ~/.claude/artifacts, so the artifact links
# emitted as http://127.0.0.1:PORT/... by link-artifact.sh are click-to-render.
#
# Linux: a file:// link can't work from a VS Code Remote-SSH terminal — it resolves on
# the LOCAL client, which does not have the remote path.
#
# macOS: the Claude desktop app resolves a clicked path against the session's granted
# folders and refuses to grant anything under its own ~/.claude tree, so a file:// link
# into the artifacts dir always fails. Its Browser pane — the only surface that renders
# .html inside the app — loads http:// but refuses file:// even for an in-session file.
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

# Detach so the server outlives this hook and the Claude session. setsid is util-linux:
# present on Linux, but on macOS only as a keg-only Homebrew formula whose bin is on the
# PATH of interactive shells alone — a hook runs non-interactive, so a bare `setsid` here
# fails with 127 and the server never starts. nohup is POSIX and on every host's PATH; it
# does not create a new session, but disown plus the closed stdin is enough to survive.
if command -v setsid >/dev/null 2>&1; then
  detach() { setsid "$@"; }
else
  detach() { nohup "$@"; }
fi

# Bind to loopback only: reachable through the SSH tunnel / forwarded port, never the LAN.
detach python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" \
  >"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true
exit 0
