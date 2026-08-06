#!/bin/bash
# Stop hook: when work has landed since the tracked artifact was last written, ask
# Claude to bring the artifact up to date and re-emit its link — so a three-slice
# plan reflects reality as each slice ships, instead of going stale until someone
# notices and asks.
#
# Stop is the only place the whole "deployed, merged AND validated" conjunction is
# observable. Matching the milestone command instead (bin/land, chezmoi apply) fires
# on partial completion: in the session that built this feature, a PostToolUse match
# on `chezmoi apply` would have fired before the deployed hook was ever probed.
#
# Pairs with link-artifact.sh, which registers the artifact and seeds the baseline
# SHA. That baseline is what makes this fire exactly once per landed slice: writing
# the artifact resets it, so a refresh is owed only while upstream is ahead of the
# artifact, and the rewrite that satisfies the nudge also clears it.

set -u

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
# shellcheck source=/dev/null
. "${ARTIFACT_STATE_LIB:-${BASH_SOURCE[0]%/*}/artifact-state.sh}"

# One forced continue is enough. A second would be a loop, and Claude has already
# been told what to do.
[[ "$(hook_field '.stop_hook_active // false')" == "true" ]] && exit 0

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
slug=$(artifact_repo_slug) || exit 0

artifact=""
[[ -f "$ARTIFACT_STATE_DIR/$slug.current" ]] && artifact=$(cat "$ARTIFACT_STATE_DIR/$slug.current")
# A deleted artifact (pruned at 7 days, or removed by hand) means the project is no
# longer tracking one. Staying silent is right; re-creating it would not be.
[[ -n "$artifact" && -f "$artifact" ]] || exit 0

ref=$(artifact_upstream_ref) || exit 0
head=$(git rev-parse "$ref" 2>/dev/null) || exit 0

base=""
[[ -f "$ARTIFACT_STATE_DIR/$slug.sha" ]] && base=$(cat "$ARTIFACT_STATE_DIR/$slug.sha")
# No baseline means the artifact predates this hook; adopt the current head silently
# rather than firing a refresh for every commit ever made.
if [[ -z "$base" ]]; then
  printf '%s\n' "$head" > "$ARTIFACT_STATE_DIR/$slug.sha" 2>/dev/null
  exit 0
fi
[[ "$head" != "$base" ]] || exit 0

landed=$(git log --oneline --no-decorate "$base..$head" 2>/dev/null | head -20)
[[ -n "$landed" ]] || exit 0
count=$(printf '%s\n' "$landed" | wc -l | tr -d ' ')

jq -n --arg a "$artifact" --arg r "${ref#refs/remotes/}" --arg n "$count" --arg l "$landed" '{
  decision: "block",
  reason: ("AUTO-ARTIFACT REFRESH (standing preference): \($n) commit(s) have landed on \($r) since the tracked artifact was last written:\n\n\($l)\n\nBring \($a) up to date before you stop: set each slice'"'"'s data-status to what is actually true now, give every newly-done slice its PR number and short SHA, refresh the summary line and the data-updated stamp, and leave slices that have not shipped alone. Then re-emit the artifact link as the LAST line of your reply, with nothing after it.\n\nIf those commits are unrelated to what this artifact describes, do not invent status — say so in one line and stop.")
}'
exit 0
