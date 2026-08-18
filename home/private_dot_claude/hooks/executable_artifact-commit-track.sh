#!/bin/bash
# PreToolUse + PostToolUse (Bash), `pre` and `post` mode in $1: record the commits
# THIS session actually created, so artifact-refresh.sh's Stop nudge names this
# session's work and nobody else's.
#
# The scheme this replaces attributed by subtraction: artifact-session-seed.sh
# snapshotted `ref..HEAD` at startup and the Stop hook treated anything newer as
# "mine". That only holds while no sibling session commits after your startup, which
# is the normal case here rather than the exception -- sessions start on a clean
# master, so the snapshot is empty (measured 2026-08-15: 70 of 71 baseline files were
# 0 bytes, making the subtraction a no-op) and EVERY commit any session lands during
# your session reads as yours. A start-time snapshot cannot fix that, because the
# information it needs does not exist yet when it is taken.
#
# Attribution has to come from an event only this session can produce, and a tool call
# is exactly that: these hooks fire in the session whose Bash call ran. `pre` stamps
# where HEAD was before the command; `post` credits this session with
# `HEAD --not <upstream> --not <tip>` -- what that one command added. `--not <upstream>`
# is what keeps a `git pull` honest: fast-forwarding a sibling's already-pushed commits
# into HEAD adds nothing, because they are upstream by definition.
#
# The `pre` half is what makes the window exact, and it is not optional. Stamping only
# in `post` measures from this session's PREVIOUS commit-shaped command, so a sibling
# committing to a shared branch between your two commits lands inside your delta --
# reproduced in tests/hooks/artifact-refresh.test.js as A(commit), B(commit),
# A(commit), where A claimed B's subject. Bounded by the command itself, only a
# sibling committing DURING your `git commit` can collide.
#
# Both halves are gated on the same string match, so a Bash call that cannot commit
# costs one regex and starts no git process -- and the two halves cannot disagree about
# whether to run, since they test the same command. A commit made by a command that does
# not look like one (a wrapper script, say) is never recorded and never nudged about.
# That is the safe direction: a missed nudge costs a stale artifact, a wrong one asserts
# another session's work as yours in a document.
#
# That gate used to be a bare word list tested against the whole command, which put
# `git show <sha>` and `head -20 bin/land` inside it, and every one of those matches
# opened a window a sibling's commit could fall into. What matters is not that the words
# appear but that the command can author a commit here -- see the filter itself.
#
# `pre` must stay silent whatever happens -- it prints nothing and always exits 0, so
# it cannot perturb the permission decision it shares PreToolUse(Bash) with.

set -u

mode="${1:-post}"

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

cmd=$(hook_field '.tool_input.command // empty')
[[ -n "$cmd" ]] || exit 0

# Match commands that can create a commit here, not commands that mention one. The
# previous filter tested the whole string against a bare word list, so `git show <sha>`,
# `head -20 bin/land` and `grep -rn commit hooks/` all passed it, and each one opened a
# `post` window measured from a HEAD that may be several commands old. That window is
# where a sibling session's commit gets adopted: it moves the shared checkout's HEAD
# while we run something read-only, and the next `post` reads the movement as ours.
# Measured 2026-08-18: one commit landed in two sessions' `.mine` this way.
#
# So the verb has to follow `git` in the same command segment, and `bin/land` has to be
# invoked rather than merely named. `fetch` is gone from the list because it cannot move
# HEAD, and bare `land` with it -- that word was matching every path under
# /tmp/chezmoi-land-*. Still loose inside a segment: `git log --grep commit` matches, and
# costs one `git log` against a tip that is fresh anyway.
#
# `merge` and `pull` are split off into their own list. They move HEAD without this
# session authoring anything -- `git checkout main && git fetch && git merge --ff-only
# origin/main` is how a session syncs after a sibling lands, and it was the command
# holding the window open in the 2026-08-18 incident. They advance the floor and record
# nothing, so a sibling committing while one runs cannot be adopted. A true merge commit
# is lost with them, which is the safe direction: it is a sync, not a slice of work.
authorverb='(^|[[:space:];&|(])git[[:space:]]([^;&|]*[[:space:]])?(commit|rebase|cherry-pick|revert|am)([[:space:]]|$)'
importverb='(^|[[:space:];&|(])git[[:space:]]([^;&|]*[[:space:]])?(merge|pull)([[:space:]]|$)'
# bin/land invoked at the start of a segment, by any path -- ./bin/land, bin/land, or
# ~/.local/share/chezmoi/bin/land -- optionally behind environment assignments, which is
# how it is run when node has to be put on PATH first.
landcmd='(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*[^[:space:];&|(]*bin/land([[:space:]]|$)'
[[ "$cmd" =~ $authorverb || "$cmd" =~ $importverb || "$cmd" =~ $landcmd ]] || exit 0

session=$(hook_field '.session_id // empty')

# shellcheck source=/dev/null
. "${ARTIFACT_STATE_LIB:-${BASH_SOURCE[0]%/*}/artifact-state.sh}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
wt=$(artifact_worktree_slug) || exit 0
ref=$(artifact_upstream_ref) || exit 0
# Same key the Stop hook and link-artifact.sh compute, including the bare-worktree
# fallback when a payload carries no session_id.
sesskey=$(artifact_session_key "$wt" "$session") || sesskey="$wt"

head=$(git rev-parse --verify --quiet HEAD) || exit 0
tipfile="$ARTIFACT_STATE_DIR/$sesskey.tip"
minefile="$ARTIFACT_STATE_DIR/$sesskey.mine"

mkdir -p "$ARTIFACT_STATE_DIR" 2>/dev/null

# `pre`: stamp where HEAD is before the command runs, and say nothing. That stamp is
# the whole point of this half -- it is what bounds the delta to this one command
# instead of to everything since this session last committed.
if [[ "$mode" == "pre" ]]; then
  printf '%s\n' "$head" > "$tipfile" 2>/dev/null
  exit 0
fi

# An import-only command moves the floor and claims nothing -- see the filter above for
# why `git merge` and `git pull` are held apart from the verbs that author work.
if ! [[ "$cmd" =~ $authorverb || "$cmd" =~ $landcmd ]]; then
  printf '%s\n' "$head" > "$tipfile" 2>/dev/null
  exit 0
fi

# No tip means the `pre` half did not run (hooks installed mid-session, or the
# SessionStart stamp failed). Claim nothing rather than claim the branch -- claiming
# the branch is the bug being fixed. Stamp so the NEXT command is attributable.
if [[ ! -s "$tipfile" ]]; then
  printf '%s\n' "$head" > "$tipfile" 2>/dev/null
  exit 0
fi
tip=$(<"$tipfile")

# A tip that no longer resolves (rebased away and gc'd) makes the delta meaningless.
# Re-stamp and record nothing, same reasoning as above.
if ! git rev-parse --verify --quiet "$tip^{commit}" >/dev/null 2>&1; then
  printf '%s\n' "$head" > "$tipfile" 2>/dev/null
  exit 0
fi

if [[ "$head" != "$tip" ]]; then
  # Subjects, not SHAs: bin/land rebases before it fast-forwards, so every SHA taken
  # before a landing is dead by the time the Stop hook looks for it upstream.
  # artifact-refresh.sh resolves these subjects against upstream instead.
  new=$(git log --format=%s "$head" --not "$ref" "$tip" 2>/dev/null)
  if [[ -n "$new" ]]; then
    printf '%s\n' "$new" >> "$minefile" 2>/dev/null
    # Bounded so a long-lived session cannot grow this without limit. Newest kept:
    # an old subject is either still unlanded (and near the tip anyway) or landed and
    # already written up long since.
    if [[ $(wc -l < "$minefile" 2>/dev/null || echo 0) -gt 500 ]]; then
      tail -500 "$minefile" > "$minefile.tmp" 2>/dev/null && mv "$minefile.tmp" "$minefile" 2>/dev/null
    fi
  fi
  printf '%s\n' "$head" > "$tipfile" 2>/dev/null
fi

exit 0
