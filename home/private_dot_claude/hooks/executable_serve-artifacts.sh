#!/usr/bin/env bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup|resume|clear
#   timeout: 5
#   order: 120
#   when: and (or (eq .chezmoi.os "linux") (eq .chezmoi.os "darwin")) (not (includeTemplate "is-agent" .))
# Serve ~/.claude/artifacts on 127.0.0.1:8181 so artifact links are click-to-render.
# Linux: file:// can't cross the VS Code Remote-SSH boundary — it resolves on the client.
# darwin: the Claude desktop app refuses to grant any path under its own ~/.claude tree,
# so every file:// link into the artifacts dir fails, and its Browser pane (the only
# in-app renderer for .html) loads http:// but not file://.
# SessionStart (Linux and macOS — wired in .chezmoitemplates/settings.base.json): ensure
# a loopback HTTP server is serving ~/.claude/artifacts, so the artifact links
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
# The server is artifact-server/artifact_server.py, vendored from the homelab's artifacts
# role (DanielH2018/Server ansible/roles/k8s/artifacts). It serves a searchable index at /,
# each artifact at /a/<host>/<relpath>, and the same file at the bare /<relpath> that
# link-artifact.sh emits. Its docstring lists where it differs from upstream.
#
# Idempotent + fast: no-op if the server is already running the current code and settings;
# otherwise it (re)starts the server in its own session (setsid) so it outlives this hook
# and the Claude session, and returns immediately so it never delays session start.
set -u

# shellcheck source=/dev/null
. "${ARTIFACT_STATE_LIB:-${BASH_SOURCE[0]%/*}/artifact-state.sh}"

PORT="${CLAUDE_ARTIFACTS_PORT:-8181}"
DIR="$HOME/.claude/artifacts"
SERVER="$HOME/.claude/hooks/artifact-server/artifact_server.py"
LOG="$HOME/.claude/.artifacts-server.log"
# The server reads one subdirectory per host under its root, because upstream mounts every
# host's tree side by side. A workstation has one tree, so the root holds one symlink to it.
ROOT="$HOME/.claude/.artifacts-root"
# The same label link-artifact.sh puts in /a/<host>/ links, and prune-artifacts.sh looks
# for in the star list.
HOST=$(artifact_host_label)
REPOS_FILE="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}/repos.tsv"
# Where CLAUDE_ARTIFACTS_BASE_URL is set, the cluster's browser is the one the links open
# and this server is only its fallback. The cluster owns the star list there and the sync
# overwrites daniel-server's copy, so this server shows stars but does not set them.
STARS_READONLY=0
[[ -n "${CLAUDE_ARTIFACTS_BASE_URL:-}" ]] && STARS_READONLY=1
# A running server keeps the code and environment it started with, so without this an
# apply that changes either reaches the browser only after a reboot. The stamp records
# both at launch, and a mismatch restarts the server.
STAMP="$HOME/.claude/.artifacts-server.stamp"
stamp=$(
  cat "${SERVER%/*}"/*.py 2>/dev/null | cksum
  printf '%s\n' "$PORT" "$HOST" "$REPOS_FILE" "$ARTIFACT_STARS_FILE" "$STARS_READONLY"
)

mkdir -p "$DIR" "$ROOT"
# A link left under an older label would list every artifact twice, once per label.
find "$ROOT" -mindepth 1 -maxdepth 1 -type l ! -name "$HOST" -delete 2>/dev/null
ln -sfn "$DIR" "$ROOT/$HOST"

# Already serving the current stamp? -> nothing to do. Match on the deployed script's full
# path, never the bare file name: on daniel-box the homelab pod runs its own
# /app/artifact_server.py, and pgrep sees container processes too.
if pgrep -f "$SERVER" >/dev/null 2>&1; then
  [[ "$(cat "$STAMP" 2>/dev/null)" == "$stamp" ]] && exit 0
  pkill -f "$SERVER" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$SERVER" >/dev/null 2>&1 || break
    sleep 0.1
  done
fi

command -v python3 >/dev/null 2>&1 || exit 0
[[ -f "$SERVER" ]] || exit 0

# Before this server existed, the hook started `python3 -m http.server $PORT`, and that
# process outlives every session. Stop it once, or the new server fails to bind and only
# $LOG records why. Wait up to a second for the port to free.
if pkill -f "http\.server ${PORT}( |$)" 2>/dev/null; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "http\.server ${PORT}( |$)" >/dev/null 2>&1 || break
    sleep 0.1
  done
fi

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

printf '%s' "$stamp" >"$STAMP"
# Bind to loopback only: reachable through the SSH tunnel / forwarded port, never the LAN.
ARTIFACTS_ROOT="$ROOT" ARTIFACTS_PORT="$PORT" ARTIFACTS_BIND=127.0.0.1 \
  ARTIFACTS_LOCAL_HOST="$HOST" ARTIFACTS_REPOS_FILE="$REPOS_FILE" \
  ARTIFACTS_STARS_FILE="$ARTIFACT_STARS_FILE" ARTIFACTS_STARS_READONLY="$STARS_READONLY" \
  PYTHONDONTWRITEBYTECODE=1 \
  detach python3 "$SERVER" >"$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true
exit 0
