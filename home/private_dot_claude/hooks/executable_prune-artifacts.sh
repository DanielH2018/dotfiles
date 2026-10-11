#!/bin/bash
# gen-hooks: register
#   event: SessionStart
#   matcher: startup
#   timeout: 10
#   order: 20
# artifacts are working docs, not an archive: drop anything untouched for 30 days
# SessionStart hook: artifacts are working documents, not an archive. Prune anything
# untouched for 30 days (CLAUDE_ARTIFACT_RETENTION_DAYS, set in settings.base.json;
# the fallback below is only for a host that skips that template) so the directory
# stays a list of what is actually live.
#
# The clock runs from the last update, not creation, so a doc that keeps getting
# refreshed as its slices land never expires — only abandoned ones do. An artifact
# starred in the artifact browser never expires at all.
#
# Emits nothing into the session: this sweeps, it does not report. A hook that
# printed a deletion list every session start would be noise on every session.

set -u

# shellcheck source=/dev/null
. "${ARTIFACT_STATE_LIB:-${BASH_SOURCE[0]%/*}/artifact-state.sh}"

DIR="${CLAUDE_ARTIFACTS_DIR:-$HOME/.claude/artifacts}"
STATE="${CLAUDE_ARTIFACT_STATE_DIR:-$HOME/.claude/logs/artifact-state}"
DAYS="${CLAUDE_ARTIFACT_RETENTION_DAYS:-7}"
STARS="$ARTIFACT_STARS_FILE"
HOST=$(artifact_host_label)

# 0 disables the sweep outright — the escape hatch for a stretch of work whose
# artifacts have to outlive the window.
[[ "$DAYS" == "0" ]] && exit 0

# A star list that exists but cannot be read would look empty, and an empty list releases
# every starred artifact. Skip the artifact sweep instead; a later session runs it.
if [[ -d "$DIR" ]] && [[ ! -e "$STARS" || -r "$STARS" ]]; then
  # Executables are tools, not reports — nvidia-install.sh and usb-early-stop.sh both
  # live here alongside the docs. They are not regenerable from a conversation the way
  # a findings page is, so the sweep leaves anything with the user-execute bit alone.
  # pinned/ holds reference pages kept on purpose, such as an architecture map. Those
  # change rarely, so mtime says nothing about whether they are still wanted.
  #
  # A starred artifact is never deleted. The list holds lines for every host the browser
  # serves, so only lines carrying this host's label count. grep -F, because a relpath is
  # a literal: building `! -path` tests from the list would turn a `[` or `*` in a file
  # name into a glob.
  find "$DIR" -type f ! -path "$DIR/pinned/*" ! -perm -u+x -mtime "+$DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' f; do
      if [[ -f "$STARS" ]] && grep -qxF -- "$HOST/${f#"$DIR"/}" "$STARS"; then
        continue
      fi
      rm -f -- "$f"
    done
  # Sweeping files out of a subdirectory leaves the directory behind; drop the empties
  # so the artifacts dir does not silently fill with husks.
  find "$DIR" -mindepth 1 -type d -empty -delete 2>/dev/null
fi

# Registry entries for artifacts that no longer exist are dead weight, and a worktree
# removed after its branch landed leaves a pending list nothing will ever clear.
if [[ -d "$STATE" ]]; then
  find "$STATE" -type f -mtime "+$DAYS" -delete 2>/dev/null
fi

exit 0
