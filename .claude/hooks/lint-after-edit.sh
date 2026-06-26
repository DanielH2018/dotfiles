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

case "$FILE_PATH" in
  *.py)
    command -v ruff >/dev/null && run_check ruff check "$FILE_PATH"
    ;;
  *.ts|*.tsx)
    # Per-file syntax check only — full tsc --noEmit -p . is too slow for a per-edit hook.
    # Relies on build/test cycle for full type checking.
    if command -v npx >/dev/null 2>&1; then
      run_check npx --no-install tsc --noEmit --isolatedModules "$FILE_PATH" 2>/dev/null
    fi
    ;;
  *.rs)
    # Walk up to find Cargo.toml from the file's location, not CWD.
    DIR=$(dirname "$FILE_PATH")
    while [ "$DIR" != "/" ]; do
      if [ -f "$DIR/Cargo.toml" ] && command -v cargo >/dev/null; then
        # Skip on cold cache — first build is too slow for a per-edit hook
        [ -d "$DIR/target" ] || break
        run_check cargo check --quiet --manifest-path "$DIR/Cargo.toml"
        break
      fi
      DIR=$(dirname "$DIR")
    done
    ;;
  *.go)
    # Use the file's directory directly — FILE_PATH is absolute.
    command -v go >/dev/null && run_check go vet "$(dirname "$FILE_PATH")/..."
    ;;
  *.java)
    # Find gradlew by walking up from the file; compileJava is fast if classes are cached.
    DIR=$(dirname "$FILE_PATH")
    while [ "$DIR" != "/" ]; do
      if [ -x "$DIR/gradlew" ]; then
        # Skip on cold cache — first Gradle build is too slow for a per-edit hook
        [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ] || break
        run_check "$DIR/gradlew" -p "$DIR" compileJava --no-daemon --quiet 2>/dev/null
        break
      fi
      DIR=$(dirname "$DIR")
    done
    ;;
  *.kt|*.kts)
    DIR=$(dirname "$FILE_PATH")
    while [ "$DIR" != "/" ]; do
      if [ -x "$DIR/gradlew" ]; then
        [ -d "$DIR/build" ] || [ -d "$DIR/.gradle" ] || break
        run_check "$DIR/gradlew" -p "$DIR" compileKotlin --no-daemon --quiet 2>/dev/null
        break
      fi
      DIR=$(dirname "$DIR")
    done
    ;;
  *.sh|*.bash)
    command -v shellcheck >/dev/null && run_check shellcheck "$FILE_PATH"
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
