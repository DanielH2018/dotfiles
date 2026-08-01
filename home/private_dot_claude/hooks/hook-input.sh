# shellcheck shell=bash
# One shared way to read a hook's stdin JSON payload and pull a field out of it with
# jq. Replaces three spellings that had drifted across the hook scripts that parse
# this payload: `echo "$INPUT" | jq -r`, `printf '%s' "$INPUT" | jq -r`, and a bare
# `jq -r` reading stdin directly. All three behave identically here — every hook in
# this directory is #!/bin/bash or #!/usr/bin/env bash, and bash's builtin `echo`
# does not interpret backslash escapes, so none of the three was ever a live bug.
# This is a consistency fix, not a security fix.
#
# The real unstated dependency is jq's presence. Most callers had no guard at all and
# silently got empty fields when jq was missing from PATH — a blocklist hook that
# can't parse its input is not "no decision", it is every subsequent check quietly
# comparing against "". hook_require_jq makes that guard a single explicit call, but
# it does not pick a policy for you: a PreToolUse gate that can't parse its input
# should usually fail open and SAY so (mode "ask", as block-dangerous-bash.sh and
# protect-secrets.sh already do by hand); a lower-stakes guard, formatter, or logger
# should usually just no-op (mode "noop", as chezmoi-guard.sh's silent `exit 0`
# already does). Each hook keeps whichever behaviour it already had — this only gives
# it one place to express it instead of a hand-rolled `command -v jq` at the top.
#
# Test seam (default is the real thing): HOOK_INPUT_STDIN — a file to read instead of
# the process's stdin, for tests that would rather not wire up a real pipe.
#
# Call hook_read_input once, as a plain statement, before the first hook_field call
# if a hook reads more than one field. hook_field is always invoked as `$(hook_field
# ...)`, which forks a subshell — so if hook_read_input has not already run in the
# hook's own (non-subshell) process, the first hook_field call reads and caches stdin
# inside ITS subshell only, and that cache dies with the subshell. A second hook_field
# call then finds nothing cached, tries to read stdin again, and gets empty (a pipe
# only gives up its bytes once). Calling hook_read_input directly first avoids this:
# it populates _HOOK_INPUT_RAW in the real process, and every later `$(hook_field
# ...)` subshell inherits that already-set value at fork time. A hook that only ever
# reads one field is safe either way.

_HOOK_INPUT_RAW=""
_HOOK_INPUT_READ=""

# hook_read_input
#   Read the payload into _HOOK_INPUT_RAW, once. Memoized so calling it more than
#   once in the same process never tries to read stdin a second time — a pipe only
#   gives up its bytes once, and a second `cat` on it would just block or return
#   empty. See the subshell caveat above for why this must be called directly (not
#   as `$(hook_read_input)`) to protect more than one hook_field call.
hook_read_input() {
  [ -n "$_HOOK_INPUT_READ" ] && return 0
  _HOOK_INPUT_READ=1
  if [ -n "${HOOK_INPUT_STDIN:-}" ]; then
    _HOOK_INPUT_RAW=$(cat "$HOOK_INPUT_STDIN" 2>/dev/null)
  else
    _HOOK_INPUT_RAW=$(cat)
  fi
}

# hook_field <jq-filter>
#   Print the filter's result against the cached stdin payload, or empty if jq is
#   missing or the payload doesn't parse. The filter is opaque — pass your own
#   `// default`, same as every call site this replaces (`.source // "startup"`,
#   `.stop_hook_active // false`, `.agent_type // "unknown"`, ...): this function
#   does not impose `// empty` on your behalf.
hook_field() {
  hook_read_input
  printf '%s' "$_HOOK_INPUT_RAW" | jq -r "$1" 2>/dev/null
}

# hook_require_jq <mode> [reason]
#   The one explicit jq-presence guard. Returns 0 if jq is on PATH — the caller
#   proceeds normally. Returns 1 if not, having already printed the caller's chosen
#   failure mode to stdout:
#
#     ask   - the PreToolUse "ask" permission-decision JSON that block-dangerous-bash.sh
#             and protect-secrets.sh already hand-roll. Pass the hook-specific reason.
#     noop  - print nothing. Right for chezmoi-guard.sh / chezmoi-apply-guard.sh's
#             silent `exit 0`, and for any formatter/logger that already no-ops on a
#             broken dependency.
#
#   Never calls exit itself: every current caller happens to exit 0 either way, but
#   that is the caller's decision, not this library's. `reason` is inlined into a
#   JSON string literal via printf %s, not jq-escaped — pass a static, quote-free
#   string (as every current call site does), never payload data.
hook_require_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  if [ "${1:-noop}" = ask ]; then
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' \
      "${2:-jq is unavailable, so this could not be evaluated.}"
  fi
  return 1
}
