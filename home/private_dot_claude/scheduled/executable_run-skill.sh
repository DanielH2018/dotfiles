#!/usr/bin/env bash
# run-skill.sh — run one Claude Code skill unattended. Linux implementation.
#
# The macOS side of this contract ships from a work-laptop repo that is not
# installed here, and launchd is macOS-only. One caller on this box names this
# exact path:
#
#   hooks/session-end.sh   run-skill.sh learning-digest headless
#
# Rewriting that caller would fork it from the Mac, where run-skill.sh exists.
# So this implements the contract it already assumes: a per-day idempotency
# marker keyed on the skill name, a log keyed the same way, and a timeout.
#
# The quiz sheet deliberately does NOT come through here — claud
# .service calls render-sheet.sh directly, so the model path bel
# the digest and nothing else.
#
# Every precondition is a skip (exit 0), not a failure. The queue survives a
# missed drain, so a deferred run costs nothing and a red timer

set -euo pipefail

SKILL="${1:-}"
MODE="${2:-headless}"
shift 2 2>/dev/null || true

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-run-skill"
LOGDIR="$HOME/.claude/logs"
TIMEOUT="${CLAUDE_RUN_SKILL_TIMEOUT:-20m}"

log()  { printf '%s %s\n' "$(date -Is)" "$*"; }
skip() { log "skip: $*"; exit 0; }

[ -n "$SKILL" ] || { printf 'usage: run-skill.sh <skill> <mode>\n' >&2; exit 2; }
case "$SKILL" in *[!a-zA-Z0-9_-]*) printf 'refusing skill name %s\n' "$SKILL" >&2; exit 2 ;; esac
: "$MODE"

mkdir -p "$STATE" "$LOGDIR"
exec >>"$LOGDIR/run-skill-$SKILL.log" 2>&1

# One run at a time per skill. The digest is fired detached from SessionEnd, so
# two sessions ending seconds apart race here — and both would c
# queue file. The loser exiting quietly is the point.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/claude-run-skill-$SKILL.lock"
flock -n 9 || skip "another $SKILL run holds the lock"

# Per-calendar-day marker. session-end.sh documents this as the reason a second
# session today no-ops: its queue entry waits for tomorrow's drain. Written only
# after a successful run, so a failure retries today.
#
# The day is the UTC day, and that is the contract: "already ran today" must not move
# with the host timezone or a DST change. This script is the marker's only reader, and
# the -mtime sweep below ages files by their own mtime, not by the name.
MARKER="$STATE/$SKILL.$(date -u +%F).done"
[ -e "$MARKER" ] && skip "$SKILL already ran today"
find "$STATE" -maxdepth 1 -name "$SKILL.*.done" -mtime +7 -delete 2>/dev/null || true

# systemd's user manager does not source a login shell, so the C
# from PATH even though an interactive shell finds it.
command -v claude >/dev/null 2>&1 || skip "claude CLI not on PATH"

# The skill stops on its own when the vault is absent, but starting a session to
# be told there is nothing to do still spends tokens.
VAULT="${CLAUDE_VAULT_DIR:-$HOME/Documents/My_Vault}"
[ -d "$VAULT" ] || skip "no vault at $VAULT"
export CLAUDE_VAULT_DIR="$VAULT"

log "running /$SKILL against $VAULT"
if timeout "$TIMEOUT" claude --dangerously-skip-permissions -p "/$SKILL"; then
  : > "$MARKER"; log "$SKILL ok"
else
  log "$SKILL failed — no marker written, will retry today"
fi
exit 0
