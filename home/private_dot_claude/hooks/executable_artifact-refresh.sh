#!/bin/bash
# Stop hook: when this worktree's own work has landed since the tracked artifact was
# last written, ask Claude to bring the artifact up to date and re-emit its link — so
# a three-slice plan reflects reality as each slice ships, instead of going stale
# until someone notices and asks.
#
# Stop is the only place the whole "deployed, merged AND validated" conjunction is
# observable. Matching the milestone command instead (bin/land, chezmoi apply) fires
# on partial completion: in the session that built this feature, a PostToolUse match
# on `chezmoi apply` would have fired before the deployed hook was ever probed.
#
# Scoped to the worktree, because several sessions work this repo at once. Diffing
# the artifact against upstream — the first version of this hook — reported every
# other session's landings as if they were yours, so a two-commit slice arrived as a
# wall of unrelated subjects. Instead each Stop records this worktree's own unlanded
# commits (`origin/HEAD..HEAD`, which is exactly the branch's work however stale the
# branch is), and the nudge fires when that set goes empty because it reached
# upstream. Another worktree landing cannot move it: their commits were never in it.
#
# The worktree alone is not a fine enough key: most sessions here work directly in
# the primary checkout (EnterWorktree is opt-in), so two unrelated sessions can hash
# to the same worktree slug and would otherwise share one pending file — one
# session's landed commits reported to the other as its own. artifact_session_key
# folds session_id in on top of the worktree slug, and artifact-session-seed.sh (a
# SessionStart hook) records what was already unlanded before this session's first
# commit, so `mine` below can subtract that baseline and keep only what is new since
# this session started — a sibling session's still-unlanded work never gets counted
# as this session's, even though `ref..HEAD` itself is shared, unscoped branch state.
#
# Subjects, not SHAs, because bin/land rebases before it fast-forwards main, so every
# SHA recorded pre-land is dead by the time the nudge fires. Resolving the subjects
# against upstream at nudge time both recovers the real post-rebase SHA and doubles
# as the did-it-actually-land check — `bin/try --back` leaves the same empty-pending
# shape as a landing, and an abandoned branch does too, so a pending set that
# resolves to nothing upstream stays silent.
#
# Committing and landing inside a single turn leaves no Stop in between and so goes
# unreported. That is the safe direction to fail, and this repo's workflow puts a
# stop there anyway: a session opens the PR and stops, and landing is a separate ask.
#
# Pairs with link-artifact.sh, which registers the artifact and clears the pending
# list. That clear is what makes this fire once per landed slice rather than every
# turn: the rewrite that answers the nudge is what satisfies it.

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
wt=$(artifact_worktree_slug) || exit 0
repo=$(artifact_repo_slug) || exit 0
session=$(hook_field '.session_id // empty')
sesskey=$(artifact_session_key "$wt" "$session") || sesskey="$wt"

# A worktree that wrote its own artifact tracks that one; otherwise it inherits the
# project's, which is how a plan written in one worktree keeps being updated as later
# slices land from others.
artifact=""
for key in "$wt" "$repo"; do
  [[ -f "$ARTIFACT_STATE_DIR/$key.current" ]] || continue
  artifact=$(cat "$ARTIFACT_STATE_DIR/$key.current")
  break
done
# A deleted artifact (pruned at 7 days, or removed by hand) means the project is no
# longer tracking one. Staying silent is right; re-creating it would not be.
[[ -n "$artifact" && -f "$artifact" ]] || exit 0

ref=$(artifact_upstream_ref) || exit 0
pending="$ARTIFACT_STATE_DIR/$sesskey.pending"
baseline="$ARTIFACT_STATE_DIR/$sesskey.baseline"

# `ref..HEAD` is shared branch state, not per-session — a sibling session's still-
# unlanded commits show up here exactly like this session's own. Subtracting the
# baseline (what was already unlanded before THIS session's first commit, recorded by
# artifact-session-seed.sh at startup) leaves only what appeared since. No baseline
# file (older payload with no session_id, or the seed hook never ran) falls back to
# the unscoped set rather than going silent.
mine_now=$(git log --format=%s "$ref..HEAD" 2>/dev/null)
if [[ -n "$mine_now" && -f "$baseline" ]]; then
  mine=$(comm -23 <(printf '%s\n' "$mine_now" | sort) <(sort "$baseline"))
else
  mine="$mine_now"
fi
if [[ -n "$mine" ]]; then
  mkdir -p "$ARTIFACT_STATE_DIR" 2>/dev/null
  printf '%s\n' "$mine" > "$pending" 2>/dev/null
  exit 0
fi

[[ -s "$pending" ]] || exit 0

# Match on the whole subject, not a substring, so one slice's "Fix the parser" does
# not claim another's "Fix the parser test".
landed=$(git log --format='%h %s' -n 200 "$ref" 2>/dev/null |
  awk 'NR==FNR { want[$0]=1; next }
       { s = substr($0, index($0, " ") + 1) }
       (s in want) && !seen[s]++ { print }' "$pending" -)
[[ -n "$landed" ]] || exit 0
count=$(printf '%s\n' "$landed" | wc -l | tr -d ' ')

# A long branch is listed in full up to a point and then counted, rather than quietly
# truncated — a cut-off list reads as the whole slice.
if [[ "$count" -gt 20 ]]; then
  landed=$(printf '%s\n' "$landed" | head -20)$'\n'"... and $((count - 20)) more"
fi

jq -n --arg a "$artifact" --arg r "${ref#refs/remotes/}" --arg n "$count" --arg l "$landed" '{
  decision: "block",
  reason: ("AUTO-ARTIFACT REFRESH (standing preference): \($n) commit(s) from this session have landed on \($r) since the tracked artifact was last written:\n\n\($l)\n\nBring \($a) up to date before you stop: set each slice'"'"'s data-status to what is actually true now, give every newly-done slice its PR number and short SHA, refresh the summary line and the data-updated stamp, and leave slices that have not shipped alone. Then re-emit the artifact link as the LAST line of your reply, with nothing after it.\n\nThose commits are this session'"'"'s own work, not another session'"'"'s. If they are still unrelated to what this artifact describes, do not invent status — say so in one line and stop.")
}'
exit 0
