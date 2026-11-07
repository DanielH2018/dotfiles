# shellcheck shell=bash
# Three outcomes, not two: evaluated-pass, evaluated-fail, and could-not-evaluate.
#
# Gates here have a habit of returning success when they could not reach a verdict — a
# signature check whose range will not resolve, a hook shim that is not executable, a
# glob matching nothing, a jq that is missing. Each one independently scores "no answer"
# as a good answer. So does ordinary code that discards a failure: an unchecked kill
# reports success, a formatter's non-zero exit is dropped, a spawn returns 0 after the
# window failed to open.
#
# The convention is that could-not-evaluate is a distinct state which is recorded, is
# visible, and is never silently a pass. Exit 3 carries it.
#
# Exit 2 is deliberately absent. A hook wired to UserPromptSubmit that exits 2 discards
# the user's prompt, so no helper here can produce it; a PreToolUse gate that cannot
# evaluate should fail closed at exit 0 with a permissionDecision of "ask" instead, the
# way block-dangerous-bash.sh already does.
#
# WHICH PRIMITIVE — decided by your hook's OUTPUT CHANNEL, not by preference:
#
#   oc_cannot   marks AND exits 3. Right when the exit code IS the verdict: pre-push
#               gates, check runners, anything whose caller reads $?.
#   oc_mark     marks only, returns 0. Right when your hook speaks JSON on stdout,
#               because oc_cannot's exit 3 would terminate the process BEFORE the
#               decision is written — the marker survives and the verdict Claude was
#               supposed to read does not.
#
# The distinction is easy to miss because oc_cannot reads like the headline API and
# oc_mark reads like its internals. lint-after-edit.sh, the first consumer, found it by
# hitting it: its only channel to Claude is a JSON `decision: "block"` with a reason, so
# it marks and emits, and never calls oc_cannot. If you are writing the third consumer,
# ask what reads your output before you pick.
#
# Seams (defaults are the real thing): OUTCOME_MARKER_DIR, UNEVAL_GATE.
#
# UNEVAL_GATE=warn demotes every could-not-evaluate from blocking to advisory, without
# losing the marker. It is the one-env-var rollback for a gate that turns out to be too
# strict mid-push.

_oc_marker_dir() {
  printf '%s\n' "${OUTCOME_MARKER_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/claude/unevaluated}"
}

# An id names a recurring condition, not an occurrence, so repeats accumulate into one
# marker rather than a pile of files. Restricted to characters that are safe as a
# filename; anything else would let a caller aim the write elsewhere.
_oc_safe_id() {
  case "$1" in
    '' | *[!A-Za-z0-9._-]*) return 1 ;;
    *) printf '%s\n' "$1" ;;
  esac
}

_oc_json_escape() {
  local text=$1
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/ }
  text=${text//$'\t'/ }
  printf '%s' "$text"
}

# oc_mark <id> <state> <reason>
#   Record an outcome without deciding what the caller does next. Never fails the
#   caller: a marker that cannot be written must not itself become an outage.
#
#   Written without jq on purpose — "jq is missing" is one of the conditions this
#   records, so the recorder cannot depend on it.
oc_mark() {
  local id state reason dir now count=1 file tmp
  id=$(_oc_safe_id "${1:-}") || return 0
  state="${2:-cannot}"
  reason=$(_oc_json_escape "${3:-}")
  dir=$(_oc_marker_dir)
  file="$dir/$id.json"

  mkdir -p "$dir" 2>/dev/null || return 0
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown')

  local first="$now"
  if [[ -r "$file" ]]; then
    local prior
    prior=$(sed -n 's/.*"n"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$file" 2>/dev/null | head -1)
    [[ -n "$prior" ]] && count=$((prior + 1))
    local seen
    seen=$(sed -n 's/.*"first"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" 2>/dev/null | head -1)
    [[ -n "$seen" ]] && first="$seen"
  fi

  tmp="$file.tmp.$$"
  printf '{"id":"%s","state":"%s","reason":"%s","n":%s,"first":"%s","last":"%s"}\n' \
    "$id" "$state" "$reason" "$count" "$first" "$now" >"$tmp" 2>/dev/null &&
    mv -f "$tmp" "$file" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
  return 0
}

# oc_cannot <id> <reason> — no verdict was reachable. Never a pass.
oc_cannot() {
  oc_mark "${1:-}" cannot "${2:-}"
  printf 'CANNOT-EVALUATE [%s] %s\n' "${1:-?}" "${2:-}" >&2
  [[ "${UNEVAL_GATE:-}" == "warn" ]] && return 0
  exit 3
}
