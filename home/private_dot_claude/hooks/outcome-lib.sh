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

oc_pass() { return 0; }

# oc_fail <id> <reason> — an actual verdict, reached and negative.
oc_fail() {
  oc_mark "${1:-}" fail "${2:-}"
  printf 'FAIL [%s] %s\n' "${1:-?}" "${2:-}" >&2
  exit 1
}

# oc_cannot <id> <reason> — no verdict was reachable. Never a pass.
oc_cannot() {
  oc_mark "${1:-}" cannot "${2:-}"
  printf 'CANNOT-EVALUATE [%s] %s\n' "${1:-?}" "${2:-}" >&2
  [[ "${UNEVAL_GATE:-}" == "warn" ]] && return 0
  exit 3
}

# oc_need <bin> <id> — a missing tool is a condition to report, not to shrug at.
oc_need() {
  command -v "${1:-}" >/dev/null 2>&1 ||
    oc_cannot "${2:-missing-$1}" "required command not on PATH: ${1:-}"
}

# oc_json <jq-filter> <id> [file]
#   jq with its exit status checked. An empty result is a real answer and is returned as
#   an empty string; a parse or invocation failure is could-not-evaluate. Ten hooks
#   currently silence jq entirely and degrade to no-ops when it breaks.
oc_json() {
  local filter="${1:-.}" id="${2:-jq}" file="${3:-}" out
  command -v jq >/dev/null 2>&1 || oc_cannot "$id" "jq is not available"
  if [[ -n "$file" ]]; then
    out=$(jq -r "$filter" "$file" 2>/dev/null) || oc_cannot "$id" "jq failed on $file"
  else
    out=$(jq -r "$filter" 2>/dev/null) || oc_cannot "$id" "jq failed on stdin"
  fi
  printf '%s' "$out"
}

# oc_run <id> <reason> -- cmd...
#   Run a command whose failure means the caller could not evaluate, rather than that
#   the thing under test is bad.
oc_run() {
  local id="${1:-}" reason="${2:-}"
  shift 2
  [[ "${1:-}" == "--" ]] && shift
  "$@" || oc_cannot "$id" "$reason"
}

# uneval count|list|ack [id] — read the marker store. Verbs, so a statusline or a gate
# can ask "is anything unevaluated?" without parsing files itself.
uneval() {
  local dir
  dir=$(_oc_marker_dir)
  case "${1:-count}" in
    count)
      local n=0 f
      shopt -s nullglob
      for f in "$dir"/*.json; do n=$((n + 1)); done
      shopt -u nullglob
      printf '%s\n' "$n"
      ;;
    list)
      shopt -s nullglob
      local f
      for f in "$dir"/*.json; do cat "$f"; done
      shopt -u nullglob
      ;;
    ack)
      local id
      id=$(_oc_safe_id "${2:-}") || return 1
      rm -f "$dir/$id.json" 2>/dev/null
      ;;
    *)
      printf 'usage: uneval count|list|ack <id>\n' >&2
      return 1
      ;;
  esac
}

# Executed rather than sourced: expose the read verbs so a statusline can call this file
# directly instead of sourcing a library into an unrelated shell.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  uneval "$@"
fi
