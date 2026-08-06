#!/bin/bash
# SessionStart hook: artifacts are working documents, not an archive. Prune anything
# untouched for a week so the directory stays a list of what is actually live.
#
# The clock runs from the last update, not creation, so a doc that keeps getting
# refreshed as its slices land never expires — only abandoned ones do.
#
# Emits nothing into the session: this sweeps, it does not report. A hook that
# printed a deletion list every session start would be noise on every session.

set -u

DIR="${CLAUDE_ARTIFACTS_DIR:-$HOME/.claude/artifacts}"
STATE="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"
DAYS="${CLAUDE_ARTIFACT_RETENTION_DAYS:-7}"

# 0 disables the sweep outright — the escape hatch for a stretch of work whose
# artifacts have to outlive the window.
[[ "$DAYS" == "0" ]] && exit 0

if [[ -d "$DIR" ]]; then
  # Executables are tools, not reports — nvidia-install.sh and usb-early-stop.sh both
  # live here alongside the docs. They are not regenerable from a conversation the way
  # a findings page is, so the sweep leaves anything with the user-execute bit alone.
  find "$DIR" -type f ! -perm -u+x -mtime "+$DAYS" -delete 2>/dev/null
  # Sweeping files out of a subdirectory leaves the directory behind; drop the empties
  # so the artifacts dir does not silently fill with husks.
  find "$DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
fi

# Registry entries for artifacts that no longer exist are dead weight, and a stale
# baseline SHA would make the Stop hook fire against a doc that is gone.
if [[ -d "$STATE" ]]; then
  find "$STATE" -type f -mtime "+$DAYS" -delete 2>/dev/null
fi

exit 0
