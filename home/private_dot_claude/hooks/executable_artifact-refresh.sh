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
# folds session_id in on top of the worktree slug so each session gets its own files.
#
# But a per-session FILE still needs a per-session ANSWER to put in it, and
# `ref..HEAD` cannot supply one: it is shared branch state, identical in every session
# looking at that checkout. The first attempt subtracted a startup snapshot of it
# (artifact-session-seed.sh) and called the remainder mine. That is only correct while
# no sibling commits after your startup — and here sessions start on a clean master,
# so the snapshot was empty in 70 of 71 recorded cases (measured 2026-08-15) and the
# subtraction was a no-op. Every commit any session landed during yours came back as
# yours, which is the bug this file kept being blamed for.
#
# So attribution no longer comes from a diff at all. artifact-commit-track.sh, a
# PostToolUse hook, records each commit at the moment this session's own Bash call
# creates it, into `<sesskey>.mine`. This hook intersects that list with what is still
# unlanded: the `.mine` entries are the claim, `ref..HEAD` only decides which of them
# have not shipped yet. A sibling's commit is in `ref..HEAD` and never in `.mine`, so
# it cannot be reported here however the branch moves. A session that commits nothing
# has no `.mine` at all and is silent by construction, rather than inheriting a branch.
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
# list when the rewrite lands. This hook also retires a set the moment it reports it,
# so the nudge is raised once per landed slice whether or not the rewrite happens —
# relying on the rewrite alone left it firing every turn when a session answered the
# reason text's own "say so in one line and stop" instead.

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
ref=$(artifact_upstream_ref) || exit 0

# Re-stamp this session's tip before anything else can exit early. Between turns is
# exactly when a sibling session's commits arrive, and absorbing them into the tip
# here is what keeps artifact-commit-track.sh's attribution window one command wide
# instead of one turn wide. Doing it before the artifact lookup matters: a project
# that starts tracking an artifact mid-session must not inherit a tip left stale from
# before it was tracked.
if head=$(git rev-parse --verify --quiet HEAD) && mkdir -p "$ARTIFACT_STATE_DIR" 2>/dev/null; then
  printf '%s\n' "$head" > "$ARTIFACT_STATE_DIR/$sesskey.tip" 2>/dev/null
fi

# Session first, then worktree, then repo. The repo entry is what lets a plan written
# in one session keep being refreshed as later slices land from others, and it stays.
# But it also aimed every session in the checkout at whichever doc was registered last,
# so a session that wrote its own artifact was told to update somebody else's — the two
# keys below it are the same string in a primary checkout, where `git rev-parse
# --git-dir` and `--git-common-dir` both answer `.git`, so neither could break the tie.
artifact=""
for key in "$sesskey" "$wt" "$repo"; do
  [[ -f "$ARTIFACT_STATE_DIR/$key.current" ]] || continue
  artifact=$(cat "$ARTIFACT_STATE_DIR/$key.current")
  break
done
# A deleted artifact (pruned at 7 days, or removed by hand) means the project is no
# longer tracking one. Staying silent is right; re-creating it would not be.
[[ -n "$artifact" && -f "$artifact" ]] || exit 0

pending="$ARTIFACT_STATE_DIR/$sesskey.pending"
minefile="$ARTIFACT_STATE_DIR/$sesskey.mine"

# What this session created (`.mine`, written per commit by artifact-commit-track.sh)
# ∩ what is still unlanded (`ref..HEAD`). Ordering follows git log, newest first, so
# the nudge reads the way the branch does. Nothing recorded means nothing claimed —
# silence, not the whole branch.
unlanded=$(git log --format=%s "$ref..HEAD" 2>/dev/null)
mine=""
if [[ -n "$unlanded" && -s "$minefile" ]]; then
  mine=$(printf '%s\n' "$unlanded" |
    awk 'NR==FNR { mine[$0]=1; next } ($0 in mine) && !seen[$0]++' "$minefile" -)
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

# Retire what is about to be reported. Rewriting the artifact clears pending through
# link-artifact.sh, but the reason below also offers a legitimate way to answer without
# writing anything -- "if they are still unrelated ... say so in one line and stop" --
# and taking it left pending intact, so the identical block fired on every following
# Stop until the file aged out at 7 days. Measured 2026-08-18: one session took it three
# times. `stop_hook_active` does not cover this; it suppresses re-entry inside one stop
# cascade, and each of those blocks was a fresh turn. Retiring here raises every landed
# set exactly once, however it is answered, and leaves a later slice free to raise its
# own.
remaining=$(awk 'NR==FNR { done[substr($0, index($0, " ") + 1)] = 1; next }
                 !($0 in done)' <(printf '%s\n' "$landed") "$pending")
if [[ -n "$remaining" ]]; then
  printf '%s\n' "$remaining" > "$pending" 2>/dev/null
else
  rm -f "$pending" 2>/dev/null
fi

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
