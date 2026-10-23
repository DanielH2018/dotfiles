#!/bin/bash
# gen-hooks: register
#   event: StopFailure
#   timeout: 5
#   order: 10
#   async: true
# StopFailure hook: tell the operator a turn ended on an API error rather than normal
# completion. Each branch is guarded by `command -v`, not gated by `when:`. gen-hooks refuses a
# lone conditional entry as an event's first group, and StopFailure has no other hook to carry
# an unconditional lowest order.
#
# macOS: a desktop notification, for rate limits only.
# Linux (daniel-box, daniel-server): a Discord page for every cause (#850). The session never
# holds the webhook. It starts the server repo's fanout-alert@<unit>:<state>.service, the
# system unit a stopped fan-out batch pages through, and that repo's polkit rule
# (50-claude-fanout-alert.rules) lets the user start it for an instance of that shape and
# nothing else. The instance is fanout-stopfailure-<cause>:failed, so the page opens with the
# cause; its body still reads as a fan-out batch's. A host without the unit or the rule
# refuses the start, which --no-ask-password keeps silent. A fan-out batch is skipped: its own
# ExecStopPost= already pages it as `failed` or `no-report`.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/lib/hook-input.sh}"
hook_read_input
# The harness names the cause `error` (rate_limit, overloaded, server_error,
# authentication_failed, max_output_tokens, unknown, ...). This read `.error_type`, which
# the payload never carries: all 277 stop_failure lines the hook wrote to sessions.log,
# until 06e9cc06 dropped that append, say error_type=unknown, and the notification below
# never fired.
ERROR_TYPE=$(hook_field '.error // "unknown"')

# Desktop notification for rate limits so the user knows to wait
case "$ERROR_TYPE" in
  rate_limit|overloaded)
    if command -v osascript >/dev/null 2>&1; then
      osascript -e 'on run argv
        display notification (item 1 of argv) with title "Claude Code" sound name "Submarine"
      end run' -- "Rate limited — try again in a few minutes" &
    fi
    ;;
esac

# The batch unit is a transient user unit named fanout-<...>.service, and every process in the
# session sits in its cgroup.
in_fanout_batch() {
  grep -qE '/fanout-[^/]+\.service$' "${STOP_FAILURE_CGROUP_FILE:-/proc/self/cgroup}" 2>/dev/null
}

# One page per cause per quiet window, not one per failed turn: a session stuck on a rate
# limit fails every turn it retries, and the alert behind server#4676 paged every 10 seconds
# before it gained a window.
QUIET_MINUTES=30

if command -v systemctl >/dev/null 2>&1 && ! in_fanout_batch; then
  # A systemd instance name may carry only a fixed alphabet. The harness's causes are
  # lower-case words joined by `_`, so anything else becomes `_`.
  CAUSE=$(printf '%s' "$ERROR_TYPE" | tr -c 'a-z0-9_' '_')
  STAMP_DIR="${XDG_RUNTIME_DIR:-/tmp}/claude-stop-alert-$(id -u)"
  STAMP="$STAMP_DIR/$CAUSE"
  if [ -z "$(find "$STAMP" -mmin "-$QUIET_MINUTES" 2>/dev/null)" ]; then
    # A stamp that cannot be written costs the window, not the page.
    { [ -d "$STAMP_DIR" ] || mkdir -m 700 "$STAMP_DIR"; } 2>/dev/null && touch "$STAMP" 2>/dev/null
    systemctl start --no-block --no-ask-password "fanout-alert@fanout-stopfailure-${CAUSE}:failed.service" \
      >/dev/null 2>&1 || true
  fi
fi

exit 0
