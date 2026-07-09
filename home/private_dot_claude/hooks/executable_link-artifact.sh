#!/bin/bash
# PostToolUse (Edit|Write): when a browser-openable artifact is written to /artifacts
# (sandbox) or ~/.claude/artifacts (host), inject a clickable file:// link into the
# MODEL's context (additionalContext) so the assistant relays it to the user in its
# reply. The link opens with Shift+Cmd+click (or Ctrl+click) in Ghostty — NOT plain
# Cmd+click: since Claude Code v2.1.89 the TUI runs on the alternate screen with mouse
# reporting, so Ghostty forwards plain Cmd+click into the app and only a Shift/Ctrl
# modifier reaches the terminal's own link handler. So the message tells the user the gesture.
#
# Why additionalContext and not systemMessage: in the wrapped/child sandbox session a
# hook's systemMessage does NOT surface to the user, but additionalContext reliably
# reaches the model. The assistant also carries a standing preference to state the link
# in its reply, so delivery does not depend on this hook alone. No-op on every other write.
#
# Host-path resolution: prefer the launcher-exported CLAUDE_ARTIFACTS_HOST_DIR; else
# derive the bind-mount source from /proc/self/mountinfo; else fall back to the path.
# In the sandbox, ~/.claude is itself a bind-mount of the host state dir, so an
# artifact written under ~/.claude/artifacts (e.g. by a skill that hardcodes that
# path) is on the host at $CLAUDE_STATE_HOST_DIR/artifacts — translate it too, or the
# emitted file:// URI would point at the unreachable in-container /home/... path.

set -u

INPUT=$(cat)
path=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)
[ -z "$path" ] && exit 0

# In the sandbox, ~/.claude/artifacts is a symlink to the /artifacts bind-mount, so
# resolve symlinks first — that collapses a ~/.claude/artifacts write onto the real
# /artifacts path and routes it through the per-instance host translation below.
# Gated to in-container (CLAUDE_STATE_HOST_DIR set) so host path emission is untouched.
if [ -n "${CLAUDE_STATE_HOST_DIR:-}" ]; then
  rp=$(readlink -f "$path" 2>/dev/null) && [ -n "$rp" ] && path="$rp"
fi

case "$path" in
  *.html|*.htm|*.pdf|*.svg|*.png|*.jpg|*.jpeg|*.gif|*.md) ;;
  *) exit 0 ;;
esac

resolve_artifacts_host() {
  if [ -n "${CLAUDE_ARTIFACTS_HOST_DIR:-}" ]; then printf '%s' "${CLAUDE_ARTIFACTS_HOST_DIR%/}"; return 0; fi
  awk '$5=="/artifacts"{print $4; exit}' /proc/self/mountinfo 2>/dev/null | sed 's#^/#/Users/#'
}

host=""
case "$path" in
  /artifacts/*)
    base=$(resolve_artifacts_host)
    if [ -n "$base" ]; then host="${base%/}/${path#/artifacts/}"; else host="$path"; fi ;;
  */.claude/artifacts/*)
    # In-container: ~/.claude/artifacts is the state bind-mount; map to its host source.
    # On the host (env unset): the path is already a real host path — emit verbatim.
    if [ -n "${CLAUDE_STATE_HOST_DIR:-}" ]; then
      host="${CLAUDE_STATE_HOST_DIR%/}/artifacts/${path#*/.claude/artifacts/}"
    else
      host="$path"
    fi ;;
  *)
    exit 0 ;;
esac

msg="An artifact was written. Include this link verbatim in your reply, and tell the user to open it with Shift+Cmd+click (or Ctrl+click) — plain Cmd+click does NOT work inside the Claude Code TUI, since v2.1.89 the TUI captures the mouse and only a Shift/Ctrl modifier reaches Ghostty's link handler. Link: "
jq -n --arg url "file://$host" --arg msg "$msg" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ($msg + $url)
  }
}'
exit 0
