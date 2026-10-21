#!/bin/bash
# gen-hooks: register
#   event: StopFailure
#   timeout: 5
#   order: 10
#   async: true
# StopFailure hook: notify on rate limits, via a macOS desktop notification.
# Fires when a turn ends due to an API error rather than normal completion. osascript is the
# only thing this hook does, so it is a no-op on Linux and Windows (the `command -v` guard
# below), not gated by `when:` — gen-hooks refuses a lone conditional entry as an event's
# first group, and StopFailure has no other hook to carry an unconditional lowest order.

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

exit 0
