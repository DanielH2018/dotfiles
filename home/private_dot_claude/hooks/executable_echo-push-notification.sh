#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: PushNotification
#   timeout: 5
#   order: 70
#   description: Echo each PushNotification message into the transcript
# PostToolUse (PushNotification): the Claude desktop app's transcript does not show the
# text of a PushNotification call, so a notification read on the phone has no trace at the
# desk. This hook prints the message back as a systemMessage, which the transcript shows,
# labelled with what the tool reported doing with it. The tool skips the push when the
# terminal is active and skips the phone when Remote Control is off, so the label comes
# from the tool's result rather than asserting a push.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/lib/hook-input.sh}"
hook_require_jq noop || exit 0
hook_read_input
message=$(hook_field '.tool_input.message // empty')
[ -z "$message" ] && exit 0
result=$(hook_field '.tool_response | if type == "string" then . else tostring end')

case "$result" in
  *"Mobile push requested"*) label="Sent to phone" ;;
  *"Not sent"*) label="Notification not sent (terminal active)" ;;
  *"Mobile push not sent"*) label="Notification sent to the desktop only" ;;
  *) label="Notification" ;;
esac

jq -n --arg msg "$label: $message" '{systemMessage: $msg}'
