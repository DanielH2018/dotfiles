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
    # Project-local tsc is usually what you want; falls back silently if absent.
    if [ -f "tsconfig.json" ] && command -v npx >/dev/null; then
      run_check npx --no-install tsc --noEmit -p .
    fi
    ;;
  *.rs)
    # cargo check is slow for large crates; skip if no Cargo.toml in CWD.
    if [ -f "Cargo.toml" ] && command -v cargo >/dev/null; then
      run_check cargo check --quiet
    fi
    ;;
  *.go)
    command -v go >/dev/null && run_check go vet "./$(dirname "$FILE_PATH")/..."
    ;;
  *.sh|*.bash)
    command -v shellcheck >/dev/null && run_check shellcheck "$FILE_PATH"
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
