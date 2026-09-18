#!/bin/bash
# gen-hooks: register
#   event: UserPromptSubmit
#   timeout: 5
#   order: 30
# learning loop, mechanism B: the pre-delegation explain gate. Inert
# unless CLAUDE_LEARN_GATE=1 -- the hook exits 0 with no output on an
# unset var, so wiring it here costs nothing until Daniel arms it.
# Defers to /prep and to prep's own `go` / `just do it` / `no intake`
# bypasses, and fires at most once per session.
# UserPromptSubmit hook: the pre-delegation explain gate. Mechanism B of
# ~/.claude/specs/learning-loop_2026-08-19.md — on a prompt that asks for a
# change and looks non-trivial, inject one instruction: state the approach in
# five lines or fewer, then ask exactly one comprehension question before
# editing. It covers the middle ground `prep` skips: work trivial enough to
# delegate directly but still worth understanding.
#
# This is the most invasive mechanism in the learning loop, so every ambiguous
# case exits silently. Default OFF: it does nothing until CLAUDE_LEARN_GATE=1.
#
# Tuning (all CLAUDE_LEARN_*, matching the SessionEnd debrief's convention):
#   CLAUDE_LEARN_GATE            1 arms the gate; unset, 0, or anything else = inert
#   CLAUDE_LEARN_GATE_MIN_WORDS  word floor below which a prompt is trivial (default 8)
#
# Deferrals, in the order they are checked:
#   - not armed
#   - no prompt, or a prompt that is only a slash command
#   - `/prep` anywhere in the prompt: prep runs its own intake, and two intakes
#     for one task is the failure this spec is most likely to hit
#   - the bypass words prep already honours: bare `go`, `just do it`, `no intake`
#   - a question rather than a request for a change
#   - below the word floor, or naming no change verb
#   - already fired once this session
#
# Known overlap, deliberately not solved here: an output style can mandate a prep
# intake on every non-trivial prompt without the user typing `/prep`. Under such a
# style the gate is redundant and double-asks. Reading settings.json from a hook to
# detect that would be clever and fragile, so the answer is to leave the gate off
# (`CLAUDE_LEARN_GATE` unset) on a machine whose style already does the intake.
#
# No style on this machine does. `daniel-voice` is the only one installed, and it
# mandates no intake — the "Fintech Terse" style this note used to name as the live
# example was removed from work-laptop-config, which was also the only thing setting
# `outputStyle` in the work overlay.
#
# Portability: /bin/bash here is 3.2, so no ${var,,} and no bash-4 syntax. Word
# boundaries go through grep -E, never a bash [[ =~ ]] — Darwin's ERE has no \b
# and the match would silently never fire.

set -u

case "${CLAUDE_LEARN_GATE:-0}" in 1) ;; *) exit 0 ;; esac

# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_require_jq noop || exit 0
hook_read_input
PROMPT=$(hook_field '.prompt // empty')
SID=$(hook_field '.session_id // empty')
[ -n "$PROMPT" ] || exit 0
[ -n "$SID" ] || SID="nosession"

# Collapse whitespace and lowercase once; every match below reads this.
FLAT=$(printf '%s' "$PROMPT" | tr '\n\t' '  ' | tr -s ' ' | sed 's/^ *//; s/ *$//' | tr '[:upper:]' '[:lower:]')
[ -n "$FLAT" ] || exit 0

# A prompt that is only a slash command is the user driving a skill, not
# delegating work. /prep in particular runs its own intake.
case "$FLAT" in /*) exit 0 ;; esac
printf '%s' "$FLAT" | grep -Eq '(^| )/prep( |$)' && exit 0

# The bypasses prep already honours. `go` is exact-match on the whole prompt:
# substring matching would fire on "google", "going", and "ago".
[ "$FLAT" = "go" ] && exit 0
printf '%s' "$FLAT" | grep -Eq 'just do it|no intake' && exit 0

# A question wants an answer, not a change. Skip anything that opens with an
# interrogative and ends in a question mark.
printf '%s' "$FLAT" | grep -Eq '^(what|why|how|where|who|which|when|is|are|does|do|did|can|could|should|would|will)\b.*\?$' && exit 0

MIN="${CLAUDE_LEARN_GATE_MIN_WORDS:-8}"
case "$MIN" in '' | *[!0-9]*) MIN=8 ;; esac
WORDS=$(printf '%s' "$FLAT" | wc -w | tr -d ' ')
case "$WORDS" in '' | *[!0-9]*) exit 0 ;; esac
[ "$WORDS" -lt "$MIN" ] && exit 0

# Fire only when the prompt actually asks for a change. Anything else — reading,
# explaining, reviewing, planning — needs no comprehension gate.
printf '%s' "$FLAT" | grep -Eq '\b(implement|add|write|fix|refactor|change|rename|migrate|remove|delete|update|wire|build|create|patch|port|rewrite|extend|hook up|land)\b' || exit 0

# Once per session. A gate that re-fires on every prompt is the friction that
# gets the whole learning loop switched off.
STATE_DIR="$HOME/.claude/logs/learning-gate-state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
FIRED="$STATE_DIR/$SID.fired"
[ -e "$FIRED" ] && exit 0
# O_EXCL via noclobber, so two prompts racing in one session inject once.
if ! (set -o noclobber; : > "$FIRED") 2>/dev/null; then exit 0; fi
# Opportunistic prune of stale per-session markers, only on the rare fire path.
find "$STATE_DIR" -type f -mtime +1 -delete 2>/dev/null

jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "EXPLAIN GATE (automated, once per session, CLAUDE_LEARN_GATE=1): this request looks like a non-trivial change being delegated. Before you edit anything: state the approach in five lines or fewer, then ask exactly one comprehension question — the question whose answer you most need from Daniel to be sure the change is right, not a quiz and not a list. Stop on that question mark and wait for the answer. If he has already given the approach, or answers with `go` / `just do it` / `no intake`, proceed straight to the work. Do not narrate this gate."
  }
}'
exit 0
