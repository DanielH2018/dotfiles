#!/bin/bash
# PostToolUse hook: auto-format files after Claude writes or edits them.
# Dispatches based on extension. Silently skips if the formatter isn't installed.
# Exit 0 always so formatting failures don't break Claude's flow; errors go to stderr.

set -u

FILE_PATH=$(jq -r '.tool_input.file_path // empty')

# Skip if no file path (some edit variants don't include it) or file doesn't exist.
[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

run_if_installed() {
  command -v "$1" >/dev/null 2>&1 && "$@" 2>&1
}

case "$FILE_PATH" in
  *.py)
    run_if_installed ruff format "$FILE_PATH" >/dev/null
    run_if_installed ruff check --fix --quiet "$FILE_PATH" >/dev/null
    ;;
  *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.json|*.jsonc|*.css|*.scss|*.html|*.yml|*.yaml)
    run_if_installed prettier --write --log-level=silent "$FILE_PATH" >/dev/null
    ;;
  *.md)
    # Skip vault markdown — Obsidian formatting (wikilinks, callouts) is non-standard
    case "$FILE_PATH" in
      */My_Vault/*) ;;
      *) run_if_installed prettier --write --log-level=silent "$FILE_PATH" >/dev/null ;;
    esac
    ;;
  *.go)
    run_if_installed gofmt -w "$FILE_PATH" >/dev/null
    ;;
  *.rs)
    run_if_installed rustfmt --quiet "$FILE_PATH" >/dev/null
    ;;
  *.sh|*.bash)
    run_if_installed shfmt -w "$FILE_PATH" >/dev/null
    ;;
  *.sql)
    run_if_installed sqlfluff fix --dialect ansi "$FILE_PATH" >/dev/null
    ;;
  *.java)
    run_if_installed google-java-format --replace "$FILE_PATH" >/dev/null
    ;;
  *.kt|*.kts)
    run_if_installed ktfmt "$FILE_PATH" >/dev/null
    ;;
  *.xml)
    run_if_installed xmllint --format --output "$FILE_PATH" "$FILE_PATH" >/dev/null
    ;;
  *.tf|*.tfvars)
    run_if_installed terraform fmt "$FILE_PATH" >/dev/null
    ;;
  *.toml)
    run_if_installed taplo fmt "$FILE_PATH" >/dev/null
    ;;
esac

exit 0
