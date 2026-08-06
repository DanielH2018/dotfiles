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

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
path=$(hook_field '.tool_input.file_path // .tool_response.filePath // empty')
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

# Default (macOS/Ghostty host): a file:// link, opened with Shift+Cmd+click.
url="file://$host"
msg="An artifact was written. Include this link verbatim as the LAST line of your reply, with nothing after it, and tell the user to open it with Shift+Cmd+click (or Ctrl+click) — plain Cmd+click does NOT work inside the Claude Code TUI, since v2.1.89 the TUI captures the mouse and only a Shift/Ctrl modifier reaches Ghostty's link handler. Link: "

# Linux host (WSL / VS Code Remote-SSH): a file:// link resolves on the LOCAL client,
# which lacks the remote path, so it errors. Emit an http:// link served by
# serve-artifacts.sh instead — WSL2 mirrored networking shares loopback with Windows,
# and VS Code forwards the port over SSH, so it renders from either. Gated to the
# non-sandbox host (CLAUDE_STATE_HOST_DIR unset) and to ~/.claude/artifacts writes;
# macOS and the sandbox keep file://.
#
# The host is 127.0.0.1, NOT localhost: serve-artifacts.sh binds IPv4 loopback only,
# but Windows resolves localhost to ::1 first, so a browser on the Windows side hangs
# on the IPv6 attempt and the artifact never renders (measured: localhost:8181 times
# out from Windows, 127.0.0.1:8181 returns 200). Naming the address family skips the
# resolution entirely and works from both sides.
if [ -z "${CLAUDE_STATE_HOST_DIR:-}" ] && [ "$(uname -s)" = "Linux" ]; then
  case "$path" in
    */.claude/artifacts/*)
      PORT="${CLAUDE_ARTIFACTS_PORT:-8181}"
      rel="${path#*/.claude/artifacts/}"
      url="http://127.0.0.1:${PORT}/${rel}"
      # Two modifiers, not one, and the message used to name only the first: Shift is the
      # xterm bypass-mouse-reporting modifier, needed because the TUI captures the mouse
      # (alt screen since v2.1.89), and Ctrl is Ghostty's own open-link modifier on Linux
      # — the counterpart of Cmd in the macOS branch above. Measured on daniel-box
      # 2026-08-01: Shift+click alone does nothing at all, Shift+Ctrl+click opens Firefox.
      # VS Code's terminal does not capture the mouse the same way and wants plain Ctrl.
      msg="An artifact was written. Include this link verbatim as the LAST line of your reply, with nothing after it, and tell the user to Shift+Ctrl+click it (plain Ctrl+click in a VS Code terminal) — it opens rendered in the browser. Link: "
      ;;
  esac
fi

# A Markdown artifact with no HTML companion is the standing preference going unmet.
# suggest-artifact.sh was supposed to catch this, but it is gated on ExitPlanMode and
# plan mode is never used here — measured 2026-08-06: zero ExitPlanMode calls across
# 653 transcripts, so that hook has never once fired. This is the trigger that does.
# Only nudge when the companion is genuinely absent, so a doc that already has one,
# or an .md written after its .html, stays quiet.
nudge=""
if [[ "$path" == *.md && ! -e "${path%.md}.html" ]]; then
  nudge=$'\n\nAUTO-ARTIFACT (standing preference): that Markdown artifact has no HTML companion. Render the same content as a self-contained HTML page as well — in addition to the Markdown, not instead of it. Load the artifact-design skill first, write it alongside as the same filename with a .html extension, and make THAT link the last line of your reply instead of the Markdown one. Keep it local: do not publish to claude.ai or call the Artifact tool unless the user explicitly asks. Skip if the doc is trivial or the user opted out.'
fi

jq -n --arg url "$url" --arg msg "$msg" --arg nudge "$nudge" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ($msg + $url + $nudge)
  }
}'
exit 0
