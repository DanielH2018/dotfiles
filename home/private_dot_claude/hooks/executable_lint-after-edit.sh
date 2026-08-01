#!/bin/bash
# PostToolUse hook for Edit/Write: run a quick syntax/type check on the edited file
# and, if it fails, feed the error back to Claude so it can self-correct.
#
# Uses the JSON output format with `decision: "block"` to surface errors to Claude.
# A non-blocking linter would just exit 0, but "block" is what lets Claude see the output.
#
# Every check runs through run_bounded() (M10) instead of a bare command
# substitution: no linter/compiler here had a timeout, output cap, or (for the
# gradle path) a cold-daemon exclusion — 300s configured on this hook alone
# (settings.base.json), 355s worst-case across the whole PostToolUse Edit|Write
# chain. See ~/.claude/specs/env-modules/M10-bounded-execution.md.

set -u

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
# SWALLOW: a hook must run without its libs rather than fail closed on the whole
# edit. The fallback stubs below (guarded on `command -v`) keep every check
# actually running — unbounded, like before this slice — instead of silently
# skipping it, per M06's "no dependency of its own" convention
# (M06-M18-outcome-convention.md:282). RUN_BOUNDED_LIB/OUTCOME_LIB are seams for
# tests to force the missing-library path without touching the real files.
# shellcheck disable=SC1090,SC1091
. "${RUN_BOUNDED_LIB:-$LIB_DIR/run-bounded.sh}" 2>/dev/null || true
# shellcheck disable=SC1090,SC1091
. "${OUTCOME_LIB:-$LIB_DIR/outcome-lib.sh}" 2>/dev/null || true
# shellcheck disable=SC1090,SC1091
. "${HOOK_INPUT_LIB:-$LIB_DIR/hook-input.sh}" 2>/dev/null || true

# Fallback when run-bounded.sh didn't source: run the check unbounded (the old
# behaviour) rather than skip it. Losing the bound is an accepted degradation
# when the lib itself can't be sourced; skipping the check silently would not be.
# shellcheck disable=SC2034  # RB_SIGNAL mirrors the real lib's out-param contract
command -v run_bounded >/dev/null 2>&1 || run_bounded() {
  shift 2
  case "${1:-}" in --) shift ;; *) shift; [ "${1:-}" = -- ] && shift ;; esac
  RB_STATUS=ok; RB_SIGNAL=""
  RB_OUT=$("$@" 2>&1); RB_EXIT=$?
}
# oc_mark never fails its caller by contract; a no-op stub preserves that if the
# lib didn't source — telemetry is lost, the check itself still runs either way.
command -v oc_mark >/dev/null 2>&1 || oc_mark() { :; }
# hook_field stub mirrors this file's OLD bare `jq -r` (reads stdin directly) if
# hook-input.sh didn't source — same degraded-but-running behaviour as the two above.
command -v hook_field >/dev/null 2>&1 || hook_field() { jq -r "$1" 2>/dev/null; }

FILE_PATH=$(hook_field '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

# Per-check bound. 8s/4MB for the interpreted/native checks; 10s for the JVM
# checks (gradle daemon warm-up headroom — see the *.java/*.kt case). These are
# initial caps from measured/estimated worst cost, not a tuned percentile — see
# spec §7.
LINT_TIMEOUT_S="${LINT_TIMEOUT_S:-8}"
LINT_CAP_BYTES="${LINT_CAP_BYTES:-4194304}"
JVM_TIMEOUT_S="${JVM_TIMEOUT_S:-10}"

OUTPUT=""
FAILED=0
CANNOT=0
CANNOT_REASON=""

# run_check <id> <timeout_s> <cap_bytes> cmd args...
#   <id> names the check for the outcome-lib marker (oc_mark), not the shell
#   command itself — a path like $DIR/gradlew isn't a safe marker filename.
#
#   RB_STATUS=ok, non-zero exit: a real lint/type failure — existing behaviour.
#   RB_STATUS!=ok (timeout/truncated/killed/error): could-not-evaluate. This
#   records via oc_mark (the marker/counter primitive), NOT oc_cannot: oc_cannot
#   calls `exit 3` on the whole process, which here would abort before the JSON
#   `decision:"block"` is ever emitted — PostToolUse hooks in this repo surface
#   text to Claude through that JSON on stdout, not through the exit code, so
#   oc_cannot's hard exit would silence the very "not evaluated" message this
#   slice exists to add. oc_mark gives the same M06 "cannot" bucket/counter
#   without that side effect.
run_check() {
  local id="$1" timeout_s="$2" cap="$3"
  shift 3
  run_bounded "$timeout_s" "$cap" -- "$@"
  case "$RB_STATUS" in
    ok)
      if [ "$RB_EXIT" -ne 0 ]; then
        OUTPUT="$RB_OUT"
        FAILED=1
      fi
      ;;
    *)
      oc_mark "lint-$id" cannot "run_bounded status=$RB_STATUS timeout=${timeout_s}s exit=${RB_EXIT:-?}"
      CANNOT_REASON="$id timed out or could not be evaluated after ${timeout_s}s (${RB_STATUS}) — not evaluated, re-run manually"
      CANNOT=1
      ;;
  esac
}

# Walk up from a starting dir to '/' looking for a marker file/dir; echo the
# containing dir on success, non-zero on failure. Bottoms out on Windows where
# dirname of a drive root repeats itself.
find_up() {
  local dir="$1" marker="$2" test_flag="${3:--e}" parent
  while [ "$dir" != "/" ]; do
    if test "$test_flag" "$dir/$marker"; then printf '%s\n' "$dir"; return 0; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  return 1
}

case "$FILE_PATH" in
  *.py)
    command -v ruff >/dev/null && run_check ruff "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" ruff check "$FILE_PATH"
    ;;
  *.ts|*.tsx)
    # Per-file syntax check only — full tsc --noEmit -p . is too slow for a per-edit hook.
    # Relies on build/test cycle for full type checking. Use the project-local tsc if
    # present; skip silently if absent so a missing compiler can't block the edit.
    # (`npx --no-install tsc` exits non-zero when typescript isn't installed, which the
    # old code mis-read as a lint failure and blocked every TS edit in such projects.)
    DIR=$(find_up "$(dirname "$FILE_PATH")" node_modules/.bin/tsc -x) &&
      run_check tsc "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" \
        "$DIR/node_modules/.bin/tsc" --noEmit --isolatedModules "$FILE_PATH"
    ;;
  *.rs)
    # Walk up to find Cargo.toml from the file's location, not CWD.
    if command -v cargo >/dev/null; then
      DIR=$(find_up "$(dirname "$FILE_PATH")" Cargo.toml -f)
      # Skip on cold cache — first build is too slow for a per-edit hook
      if [ -n "$DIR" ] && [ -d "$DIR/target" ]; then
        run_check cargo "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" \
          cargo check --quiet --manifest-path "$DIR/Cargo.toml"
      fi
    fi
    ;;
  *.go)
    # Vet only the immediate package (not recursive) to keep per-edit latency low.
    command -v go >/dev/null && run_check govet "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" go vet "$(dirname "$FILE_PATH")"
    ;;
  *.java)
    # Find gradlew by walking up from the file; compileJava is fast if classes are cached.
    DIR=$(find_up "$(dirname "$FILE_PATH")" gradlew -x)
    # Skip on cold cache — first Gradle build is too slow for a per-edit hook.
    # --no-daemon dropped (A4-26): it forced a cold JVM start every edit, 10-40s
    # estimated; a warm daemon call is the single biggest latency win available
    # here, which is why JVM_TIMEOUT_S is still 10s insurance against a
    # different slow case, not a tuned percentile of the removed one (spec §7).
    if [ -n "$DIR" ] && { [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ]; }; then
      run_check gradle-compileJava "$JVM_TIMEOUT_S" "$LINT_CAP_BYTES" \
        "$DIR/gradlew" -p "$DIR" compileJava --quiet
    fi
    ;;
  *.kt|*.kts)
    DIR=$(find_up "$(dirname "$FILE_PATH")" gradlew -x)
    if [ -n "$DIR" ] && { [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ]; }; then
      run_check gradle-compileKotlin "$JVM_TIMEOUT_S" "$LINT_CAP_BYTES" \
        "$DIR/gradlew" -p "$DIR" compileKotlin --quiet
    fi
    ;;
  *.sh|*.bash)
    # -e SC1091: our hooks `source` helpers by their runtime path (~/.claude/hooks/…) that
    # ShellCheck can't follow statically — an info-level note. Since the hook blocks on any
    # finding, excluding it stops every edit to a sourced script from nagging. Other checks stay.
    command -v shellcheck >/dev/null && run_check shellcheck "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" \
      shellcheck -e SC1091 "$FILE_PATH"
    ;;
  */Dockerfile|*/Dockerfile.*)
    command -v hadolint >/dev/null && run_check hadolint "$LINT_TIMEOUT_S" "$LINT_CAP_BYTES" hadolint "$FILE_PATH"
    ;;
esac

if [ "$CANNOT" -eq 1 ]; then
  jq -n --arg reason "$CANNOT_REASON" '{decision: "block", reason: $reason}'
  exit 0
fi

if [ "$FAILED" -eq 1 ]; then
  # A failing tsc or gradle run can emit thousands of lines, and every one of them was
  # pasted into the block reason — i.e. straight into the model's context — for a single
  # edit. Keep the head, where the first real error is, and say what was dropped rather
  # than truncating silently.
  MAX_LINES=40
  TOTAL=$(printf '%s\n' "$OUTPUT" | wc -l | tr -d '[:space:]')
  if [ "$TOTAL" -gt "$MAX_LINES" ]; then
    OUTPUT="$(printf '%s\n' "$OUTPUT" | head -n "$MAX_LINES")

[$((TOTAL - MAX_LINES)) more line(s) truncated — re-run the checker for the full output]"
  fi
  jq -n --arg reason "Lint/typecheck failed after edit:

$OUTPUT" '{
    decision: "block",
    reason: $reason
  }'
fi

exit 0
