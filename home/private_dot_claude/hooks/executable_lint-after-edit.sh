#!/bin/bash
# PostToolUse hook for Edit/Write: run a quick syntax/type check on the edited file
# and, if it fails, feed the error back to Claude so it can self-correct.
#
# Uses the JSON output format with `decision: "block"` to surface errors to Claude.
# A non-blocking linter would just exit 0, but "block" is what lets Claude see the output.

set -u

FILE_PATH=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

OUTPUT=""
FAILED=0

run_check() {
  if ! OUTPUT=$("$@" 2>&1); then
    FAILED=1
  fi
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
    command -v ruff >/dev/null && run_check ruff check "$FILE_PATH"
    ;;
  *.ts|*.tsx)
    # Per-file syntax check only — full tsc --noEmit -p . is too slow for a per-edit hook.
    # Relies on build/test cycle for full type checking. Use the project-local tsc if
    # present; skip silently if absent so a missing compiler can't block the edit.
    # (`npx --no-install tsc` exits non-zero when typescript isn't installed, which the
    # old code mis-read as a lint failure and blocked every TS edit in such projects.)
    DIR=$(find_up "$(dirname "$FILE_PATH")" node_modules/.bin/tsc -x) &&
      run_check "$DIR/node_modules/.bin/tsc" --noEmit --isolatedModules "$FILE_PATH"
    ;;
  *.rs)
    # Walk up to find Cargo.toml from the file's location, not CWD.
    if command -v cargo >/dev/null; then
      DIR=$(find_up "$(dirname "$FILE_PATH")" Cargo.toml -f)
      # Skip on cold cache — first build is too slow for a per-edit hook
      if [ -n "$DIR" ] && [ -d "$DIR/target" ]; then
        run_check cargo check --quiet --manifest-path "$DIR/Cargo.toml"
      fi
    fi
    ;;
  *.go)
    # Vet only the immediate package (not recursive) to keep per-edit latency low.
    command -v go >/dev/null && run_check go vet "$(dirname "$FILE_PATH")"
    ;;
  *.java)
    # Find gradlew by walking up from the file; compileJava is fast if classes are cached.
    DIR=$(find_up "$(dirname "$FILE_PATH")" gradlew -x)
    # Skip on cold cache — first Gradle build is too slow for a per-edit hook
    if [ -n "$DIR" ] && { [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ]; }; then
      run_check "$DIR/gradlew" -p "$DIR" compileJava --no-daemon --quiet 2>/dev/null
    fi
    ;;
  *.kt|*.kts)
    DIR=$(find_up "$(dirname "$FILE_PATH")" gradlew -x)
    if [ -n "$DIR" ] && { [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ]; }; then
      run_check "$DIR/gradlew" -p "$DIR" compileKotlin --no-daemon --quiet 2>/dev/null
    fi
    ;;
  *.sh|*.bash)
    # -e SC1091: our hooks `source` helpers by their runtime path (~/.claude/hooks/…) that
    # ShellCheck can't follow statically — an info-level note. Since the hook blocks on any
    # finding, excluding it stops every edit to a sourced script from nagging. Other checks stay.
    command -v shellcheck >/dev/null && run_check shellcheck -e SC1091 "$FILE_PATH"
    ;;
  */Dockerfile|*/Dockerfile.*)
    command -v hadolint >/dev/null && run_check hadolint "$FILE_PATH"
    ;;
esac

if [ "$FAILED" -eq 1 ]; then
  jq -n --arg reason "Lint/typecheck failed after edit:

$OUTPUT" '{
    decision: "block",
    reason: $reason
  }'
fi

exit 0
