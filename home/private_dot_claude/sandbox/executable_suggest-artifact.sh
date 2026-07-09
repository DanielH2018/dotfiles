#!/bin/bash
# PostToolUse hook (ExitPlanMode) for the claude-sandbox container: after a plan is
# approved, nudge Claude to also render it as an HTML artifact for readability. The
# artifact stays LOCAL — written to /artifacts (bind-mounted to the host artifacts
# dir) — and is NOT published to claude.ai unless the user explicitly asks. Injects
# guidance only; never blocks. Claude applies judgment (skips trivial/rejected plans).
#
# INTENTIONAL TWIN of hooks/executable_suggest-artifact.sh — the two differ ONLY in
# artifact path (host: ~/.claude/artifacts; sandbox: /artifacts bind-mount). Keep the
# logic in sync when editing either; they are deliberately not a single file.

set -u

# Drain the tool payload on stdin; this is a static, event-triggered reminder.
cat >/dev/null 2>&1 || true

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "AUTO-ARTIFACT (standing preference): You just presented an implementation plan via ExitPlanMode. If the user approved it and it is non-trivial, also render the plan as an HTML artifact for readability — in addition to executing the plan, not instead of it. Keep it LOCAL: (1) load the artifact-design skill to calibrate design effort, (2) write a self-contained HTML page of the plan (phases, files touched, build sequence, risks) to /artifacts/ (bind-mounted to the host, survives the container), (3) tell the user the file path. Do NOT publish to claude.ai / call the Artifact tool unless the user explicitly asks you to. Skip entirely if the plan is a one-liner, the user opted out, or the plan was rejected."
  }
}'

exit 0
