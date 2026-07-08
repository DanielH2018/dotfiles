#!/bin/bash
# PostToolUse hook (ExitPlanMode): after a plan is approved, nudge Claude to also
# render it as a shareable HTML artifact for readability — my standing preference to
# auto-visualize specs and implementation plans without being asked. Injects guidance
# only; never blocks. Claude applies judgment (skips trivial or rejected plans).

set -u

# Drain the tool payload on stdin; this is a static, event-triggered reminder.
cat >/dev/null 2>&1 || true

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "AUTO-ARTIFACT (standing preference): You just presented an implementation plan via ExitPlanMode. If the user approved it and it is non-trivial, also render the plan as a shareable HTML artifact for readability — in addition to executing the plan, not instead of it. Steps: (1) load the artifact-design skill to calibrate design effort, (2) write a self-contained HTML page of the plan (phases, files touched, build sequence, risks) to your scratchpad, (3) publish it with the Artifact tool and share the link. Skip only if the plan is a one-liner, the user opted out, or the plan was rejected. Artifacts are private to the user by default — still use judgment before publishing secrets or customer data."
  }
}'

exit 0
