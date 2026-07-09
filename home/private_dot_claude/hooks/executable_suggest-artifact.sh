#!/bin/bash
# PostToolUse hook (ExitPlanMode): after a plan is approved, nudge Claude to also
# render it as an HTML artifact for readability — my standing preference to
# auto-visualize specs and implementation plans without being asked. The artifact
# stays LOCAL by default (a file on disk); it is NOT published to claude.ai unless
# I explicitly ask. Injects guidance only; never blocks. Claude applies judgment
# (skips trivial or rejected plans).
#
# Single source of truth for host AND the claude-sandbox container. The only thing
# that differs between the two is the artifact directory, so it's parameterized:
# the container sets ARTIFACT_DIR=/artifacts (a host-backed bind-mount); on the
# host it defaults to ~/.claude/artifacts. The launcher mounts this exact file.

set -u

# Drain the tool payload on stdin; this is a static, event-triggered reminder.
cat >/dev/null 2>&1 || true

ART_DIR="${ARTIFACT_DIR:-$HOME/.claude/artifacts}"

jq -n --arg art "$ART_DIR" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "AUTO-ARTIFACT (standing preference): You just presented an implementation plan via ExitPlanMode. If the user approved it and it is non-trivial, also render the plan as an HTML artifact for readability — in addition to executing the plan, not instead of it. Keep it LOCAL: (1) load the artifact-design skill to calibrate design effort, (2) write a self-contained HTML page of the plan (phases, files touched, build sequence, risks) to \($art)/ (create it if needed), (3) tell the user the file path. Do NOT publish to claude.ai / call the Artifact tool unless the user explicitly asks you to. Skip entirely if the plan is a one-liner, the user opted out, or the plan was rejected."
  }
}'

exit 0
