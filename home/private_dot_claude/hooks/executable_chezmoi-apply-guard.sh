#!/bin/bash
# gen-hooks: register
#   event: PreToolUse
#   matcher: Bash
#   timeout: 15
#   order: 30
# gen-hooks: register
#   event: PostToolUse
#   matcher: Bash
#   timeout: 20
#   order: 25
#   args: post
# PreToolUse (Bash) hook: stop `chezmoi apply` reverting a deployed file that
# something other than chezmoi wrote, or deploying from a primary source checkout
# that is behind origin/main (see "a primary source checkout behind origin/main"
# below). Invoked with `post` as a PostToolUse hook, it prints what an
# `chezmoi apply --source <worktree>` left ahead of the primary checkout instead.
#
# Worktree jobs deploy a build straight to its target path to exercise it in a
# real terminal, so on this machine "deployed differs from source" usually means
# the deployed copy is AHEAD, not stale — and the deployed bytes are the only
# copy. A parallel session running `chezmoi apply` then silently reverts it:
# on 2026-07-24 an in-progress agentview build was reverted mid-test.
#
# `chezmoi status` already distinguishes the two cases exactly, so this needs no
# heuristic. Its first column is the deployed file vs. the last state chezmoi
# wrote, the second is what apply will do:
#
#   " M path"   source edited, deployed untouched   -> the normal workflow, allowed
#   "MM path"   deployed edited outside chezmoi     -> apply would discard it, denied
#
# Override for a deliberate revert:  CHEZMOI_APPLY_GUARD=off chezmoi apply ...
#
# WHICH command is an apply, and WHICH paths it names, are decided by
# claude_guard.segment — the same parser the deny hook runs — and not by globbing
# the flattened command text. Four measured misreadings of the text version, all
# reproduced against the stub in tests/chezmoi/chezmoi-apply-guard.test.js:
#
#   chezmoi apply 2>&1 | tee /tmp/apply.log   ALLOWED a clobbering apply: the target
#   cd /tmp && chezmoi apply                  scan took every /-rooted token in the
#                                             WHOLE command, so a log path or a `cd`
#                                             argument narrowed the guard to a
#                                             directory no conflict could be under.
#   echo CHEZMOI_APPLY_GUARD=off; chezmoi apply   ALLOWED: the override matched
#                                             anywhere in the text, including inside
#                                             another command's arguments.
#   git commit -m "fix chezmoi apply guard"   DENIED a commit: `*chezmoi*\ apply*`
#                                             matches the words wherever they sit,
#                                             quoted or not.
#   chezmoi apply -n                          DENIED although `-n` IS the dry-run
#                                             flag: the glob wanted a trailing space.
#
# The first two are the ones that matter: a guard that fails open on the shapes an
# agent actually types is worse than no guard, because the session believes it ran.
#
# Parsed, the decision is over the chezmoi command's own argv: leading assignments
# are the only place the override counts, the verb and the dry-run flag are tokens
# rather than substrings, and targets come from that command's arguments alone.
# Substitutions are read too, so `$(chezmoi apply)` is still seen.
#
# The parser is not a dependency this hook may fail on. No interpreter, no package,
# or a command the parser calls unreadable (an unbalanced quote) all fall back to
# the flattened-text scan below, which is what this hook did before. That fallback
# is looser, never stricter: it is the old behaviour, incidents and all.

set -u

MODE=${1:-pre}
command -v chezmoi >/dev/null 2>&1 || exit 0
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input
hook_require_jq noop || exit 0

COMMAND=$(hook_field '.tool_input.command // empty')
[ -n "$COMMAND" ] || exit 0

# The cheap prefilter, ahead of any interpreter. This hook fires on every Bash call
# and almost none of them name chezmoi at all. It is deliberately a superset of what
# the parser can decide: a command with no `chezmoi` in its text cannot hold a
# chezmoi invocation in any segment or substitution.
case "$COMMAND" in
  *chezmoi*) ;;
  *) exit 0 ;;
esac

# ── the parsed decision ──────────────────────────────────────────────────────────
#
# Prints one of:
#   off              an apply, with the documented override on that same command
#   skip             no chezmoi command here that writes deployed files
#   write            an apply; any following lines are the targets it named
#   unreadable       the parser refused (see its module docstring: a refusal is
#                    never a skip) — the caller falls back
#
# The interpreter lookup is guard-pre-tool-use.sh's, flag for flag, and for its
# reasons: --no-project/--system/--managed-python keep uv from answering with a
# worktree's own venv, -S -P stop a cwd-local claude_guard.py shadowing the package.
GUARD_SHARE="${CLAUDE_GUARD_HOME:-${HOME:-}/.local/share/claude-guard}"

parsed_decision() {
  [ -f "$GUARD_SHARE/claude_guard/segment.py" ] || return 1
  local py
  py=$(uv python find --no-project --managed-python --system 3.14 2>/dev/null) || return 1
  [ -x "$py" ] || return 1
  CG_SHARE="$GUARD_SHARE" "$py" -S -P -c '
import os, shlex, sys

sys.path.insert(0, os.environ["CG_SHARE"])
from claude_guard.segment import parse

command = sys.stdin.read()
p = parse(command)
if not p.ok:
    print("unreadable")
    raise SystemExit(0)

# Substitutions as well as top-level segments: `$(chezmoi apply)` runs an apply. Each
# top-level segment carries where it starts, so the override the deny message suggests
# can be put on the chezmoi command rather than on whatever the command line opens with.
pieces = []
cursor = 0
for seg in p.segments:
    at = command.find(seg.text, cursor)
    if at < 0:
        at = cursor
    cursor = at + len(seg.text)
    # A segment after a separator starts with the whitespace that followed it; point
    # past that, or the suggested override reads with a double space in it.
    pieces.append((seg.text, at + len(seg.text) - len(seg.text.lstrip())))
pieces.extend((sub, 0) for sub in p.substitutions)


# A redirection is not an argument. `2>&1`, `>`, `2> file` and the operand of any bare
# operator would otherwise read as a target or, worse, as the verb. A token made only of
# operator characters ALWAYS takes the next word -- `2>`, `&>` and `2>>` are operators
# just as `>` is, and treating them as anything else let `chezmoi apply 2> /dev/null`
# narrow the guard to /dev/null and run.
def arguments(argv):
    out, skip_next = [], False
    for tok in argv:
        if skip_next:
            skip_next = False
            continue
        bare = tok.lstrip("0123456789")
        if bare and set(bare) <= {"<", ">", "&"}:
            skip_next = True
            continue
        if tok.startswith((">", "<")) or (tok[:1].isdigit() and (">" in tok or "<" in tok)):
            continue
        out.append(tok)
    return out


targets = []
writes = False
at_offset = 0
sourced = False
reads_primary = False
for piece, offset in pieces:
    try:
        argv = shlex.split(piece)
    except ValueError:
        print("unreadable")
        raise SystemExit(0)
    # Leading assignments are the only place the override counts, because they are
    # the only place bash would let it reach the chezmoi process. It is also PER
    # command: `CHEZMOI_APPLY_GUARD=off chezmoi apply ~/x && chezmoi apply` overrides
    # the first apply and leaves the second one guarded.
    seg_override = False
    i = 0
    while i < len(argv) and "=" in argv[i] and argv[i].split("=", 1)[0].isidentifier():
        if argv[i] == "CHEZMOI_APPLY_GUARD=off":
            seg_override = True
        i += 1
    if seg_override:
        continue
    if i >= len(argv) or os.path.basename(argv[i]) != "chezmoi":
        continue
    rest = arguments(argv[i + 1 :])
    # `apply` writes; so does `update` (pull + apply) and `init --apply`. Matched as
    # whole tokens, which is the difference from the glob. Kept loose about WHERE in
    # the argv they sit rather than parsing chezmoi own global flags: a verb this
    # misses is a guard that does not fire.
    if not ({"apply", "update", "--apply"} & set(rest)):
        continue
    # --dry-run writes nothing, so it can never clobber. `-n` is its short form and
    # is a token here, so a trailing one counts.
    if {"--dry-run", "-n"} & set(rest):
        continue
    if not writes:
        at_offset = offset
    writes = True
    # `--source <dir>` / `-S <dir>` names the source tree, not a target: its operand is
    # skipped here, or a worktree path would narrow the conflict scan to itself. The flag
    # also marks the apply as deploying from somewhere other than the primary checkout.
    skip_next = False
    piece_sourced = False
    for t in rest:
        if skip_next:
            skip_next = False
            continue
        if t in ("--source", "-S"):
            skip_next = True
            piece_sourced = True
            continue
        if t.startswith("--source=") or (t.startswith("-S") and len(t) > 2):
            piece_sourced = True
            continue
        if t.startswith(("/", "~/")):
            targets.append(t)
    # A source that is behind origin/main only matters to an apply that reads it. An
    # --source apply reads another tree, and update / init --apply pull before applying.
    sourced = sourced or piece_sourced
    if not piece_sourced and not ({"update", "--apply"} & set(rest)):
        reads_primary = True

if not writes:
    print("skip")
else:
    print("write")
    print(at_offset)
    print(("primary" if reads_primary else "noprimary") + ("+sourced" if sourced else ""))
    for t in targets:
        print(t)
' 2>/dev/null <<<"$COMMAND"
}

# ── the flattened-text fallback ──────────────────────────────────────────────────
#
# What this hook did before the parser, kept verbatim as the answer when the parser
# cannot run. Collapse continuations so a `\`-split cannot hide the verb.
# shellcheck disable=SC1003  # the literal backslash is the point, not an escape
SCAN=$(printf '%s' "$COMMAND" | tr '\n\t\\' '   ')

text_decision() {
  case "$SCAN" in
    *CHEZMOI_APPLY_GUARD=off*) printf 'skip\n'; return 0 ;;
  esac
  case "$SCAN" in
    *chezmoi*\ apply*|*chezmoi*\ update*|*chezmoi*--apply*) ;;
    *) printf 'skip\n'; return 0 ;;
  esac
  case "$SCAN" in
    *\ --dry-run*|*\ -n\ *) printf 'skip\n'; return 0 ;;
  esac
  # Offset 0: with no segmentation there is nothing better to point at than the start
  # of the whole command, which is the form this hook always suggested.
  printf 'write\n0\n'
  # Line 3, as the parser prints it: does this apply read the primary checkout?
  case "$SCAN" in
    *\ --source*|*\ -S*) printf 'noprimary+sourced\n' ;;
    *\ update*|*--apply*) printf 'noprimary\n' ;;
    *) printf 'primary\n' ;;
  esac
  printf '%s\n' "$SCAN" | tr ' ' '\n' | grep -E '^(/|~/)' || true
}

DECISION=$(parsed_decision) || DECISION=''
case "${DECISION%%$'\n'*}" in
  skip|write) ;;
  *) DECISION=$(text_decision) ;;
esac

VERDICT=${DECISION%%$'\n'*}
[ "$VERDICT" = "write" ] || exit 0
OFFSET=$(printf '%s' "$DECISION" | sed -n '2p')
case "$OFFSET" in ''|*[!0-9]*) OFFSET=0 ;; esac
READS=$(printf '%s' "$DECISION" | sed -n '3p')
TARGETS=$(printf '%s' "$DECISION" | tail -n +4)

# The override goes on the chezmoi command, not on whatever the line opens with. The
# assignment only reaches the process it prefixes, so `CHEZMOI_APPLY_GUARD=off cd /tmp &&
# chezmoi apply` sets it for `cd` and the apply is denied again -- a loop, since that is
# what this message used to suggest.
OVERRIDE="${COMMAND:0:$OFFSET}CHEZMOI_APPLY_GUARD=off ${COMMAND:$OFFSET}"

# ── post: what an --source apply left ahead of the primary checkout ─────────────
#
# Deploying from a worktree is how unlanded config gets tested, and it leaves $HOME
# AHEAD of what the primary checkout can reproduce: the next plain apply reverts it.
# `chezmoi diff` against the default source shows exactly that, so after an --source
# apply this prints it (#583). Encrypted entries and scripts are excluded, since the
# diff renders both and this output lands in the transcript. Bounded, and silent on
# any chezmoi failure: a missing diff is a missed reminder, never a failed command.
if [ "$MODE" = "post" ]; then
  case "$READS" in *+sourced) ;; *) exit 0 ;; esac
  DIFF_ARGS=()
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    case "$t" in "~"*) t="$HOME${t#\~}" ;; esac
    DIFF_ARGS+=("$t")
  done <<EOF
$TARGETS
EOF
  DIFF=$(chezmoi diff --no-pager --exclude=encrypted,scripts ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"} 2>/dev/null) || exit 0
  [ -n "$DIFF" ] || exit 0
  LIMIT=6000
  if [ "${#DIFF}" -gt "$LIMIT" ]; then
    DIFF="${DIFF:0:$LIMIT}
[... truncated at $LIMIT of ${#DIFF} characters; run \`chezmoi diff\` for the rest]"
  fi
  MSG="chezmoi-apply-guard: this --source apply left \$HOME ahead of the primary source checkout. A plain \`chezmoi apply\` would undo the lines below (the diff runs from the deployed file to the primary source), so they stay unlanded until the branch lands:

$DIFF"
  jq -n --arg msg "$MSG" '{
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: $msg }
  }'
  exit 0
fi

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# ── a primary source checkout behind origin/main ─────────────────────────────────
#
# bin/land merges by pushing <branch>:main, which moves origin/main and nothing else.
# An apply before bin/land-sync reads the primary checkout's stale working tree and
# redeploys pre-landing content, silently reverting what just landed, and `chezmoi
# diff` stays quiet because deployed and stale source agree (#583). Checked ahead of
# the status scan below, which exits early on a tree with no conflicts.
#
# Against the LOCAL origin/main ref, with no fetch. Measured on 2026-09-23: `git
# rev-list --count` answered in under 10ms, `git ls-remote origin` in 0.64-0.69s and
# `git fetch --dry-run` in 0.56s, on a hook that runs before every apply. The local ref
# is current for every landing made on this machine, because a push updates the
# remote-tracking ref from any worktree; a landing from another machine is invisible
# here until something fetches. Any git failure is no opinion.
if [ "${READS%%+*}" = "primary" ]; then
  SRC_DIR=$(chezmoi source-path 2>/dev/null) || SRC_DIR=''
  if [ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ]; then
    BEHIND=$(git -C "$SRC_DIR" rev-list --count HEAD..refs/remotes/origin/main 2>/dev/null) || BEHIND=''
    case "$BEHIND" in ''|*[!0-9]*) BEHIND=0 ;; esac
    if [ "$BEHIND" -gt 0 ]; then
      TOP=$(git -C "$SRC_DIR" rev-parse --show-toplevel 2>/dev/null) || TOP=$SRC_DIR
      BRANCH=$(git -C "$SRC_DIR" symbolic-ref --short -q HEAD 2>/dev/null) || BRANCH=''
      if [ "$BRANCH" = "main" ]; then
        FIX="The checkout is on main, so bin/land-sync fast-forwards it. Run it, then apply again."
      else
        FIX="The checkout is on ${BRANCH:-a detached HEAD}, not main. bin/land-sync advances the main ref without leaving it; the switch back is \`bin/try --back\`, which deploys to the operator's live \$HOME and is theirs to run."
      fi
      deny "chezmoi apply reads its source from $TOP, which is $BEHIND commit(s) behind origin/main. Applying now redeploys the pre-landing content and silently reverts what landed, and \`chezmoi diff\` does not show it.

$FIX

This compares against the local origin/main ref; nothing was fetched. If deploying the older source is deliberate:

  ${OVERRIDE}"
    fi
  fi
fi

# Whole-tree status: cheap enough here (this hook only fires on an apply) and it
# avoids having to parse chezmoi's own flags out of the command line to find the
# targets. Our own failure must never block the user's command.
STATUS=$(chezmoi status --path-style=absolute 2>/dev/null) || exit 0
[ -n "$STATUS" ] || exit 0

# Column 1 in [ADM] means the deployed entry changed since chezmoi last wrote it;
# column 2 in [ADM] means apply would overwrite that change. Both, and only both.
CONFLICTS=$(printf '%s\n' "$STATUS" | grep -E '^[ADM][ADM] ' || true)
[ -n "$CONFLICTS" ] || exit 0

# If the command named specific targets, only conflicts on those paths matter.
if [ -n "$TARGETS" ]; then
  MATCHED=''
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p=${line#???}
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      case "$t" in "~"*) t="$HOME${t#\~}" ;; esac
      case "$p" in "$t"|"$t"/*) MATCHED="${MATCHED}${line}"$'\n' ; break ;; esac
    done <<EOF
$TARGETS
EOF
  done <<EOF
$CONFLICTS
EOF
  CONFLICTS=$(printf '%s' "$MATCHED")
  [ -n "$CONFLICTS" ] || exit 0
fi

PATHS=$(printf '%s\n' "$CONFLICTS" | sed 's/^...//' | sed 's/^/  /')
FIRST=$(printf '%s\n' "$CONFLICTS" | head -1 | sed 's/^...//')

REASON="chezmoi apply would overwrite a file that something other than chezmoi wrote:

$PATHS

On this machine that usually means a parallel worktree job deployed a build there to test it, and the deployed bytes are the only copy — applying reverts its work mid-test. Read the change before deciding:

  chezmoi diff $FIRST

If the diff REMOVES things the source never had, another job owns that file — recover it from ~/.local/share/chezmoi/.claude/worktrees/*/ and leave it alone. If the revert is what you actually want:

  ${OVERRIDE}"

jq -n --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
