#!/bin/bash
# gen-hooks: register
#   event: PostToolUse
#   matcher: Edit|Write|NotebookEdit
#   timeout: 30
#   order: 30
#   statusMessage: Formatting...
# PostToolUse hook: auto-format files after Claude writes or edits them.
# Dispatches based on extension. Skips when the formatter isn't installed, saying so on
# stderr once per tool per day.
# Exit 0 so formatting failures don't break Claude's flow; errors go to stderr. The one
# exit 1 is a missing run-bounded.sh, a broken install rather than a formatting failure.

set -u

# shellcheck disable=SC1091  # optional per-host env, not present in the chezmoi tree
[ -f "$HOME/.config/claude/local.env" ] && . "$HOME/.config/claude/local.env"
# shellcheck source=/dev/null
. "${HOOK_INPUT_LIB:-${BASH_SOURCE[0]%/*}/hook-input.sh}"
hook_read_input

FILE_PATH=$(hook_field '.tool_input.file_path // empty')

# Skip if no file path (some edit variants don't include it) or file doesn't exist.
[ -z "$FILE_PATH" ] && exit 0
[ ! -f "$FILE_PATH" ] && exit 0

# Every formatter runs through run_bounded, like every other hook child (#581). A hung
# formatter used to hold the hook until the harness killed it at 30s, which reads as a
# hook error and says nothing about which tool hung. A missing library is a broken
# install: say so and exit 1, which the harness reports as a non-blocking hook error,
# rather than run the formatters with no bound.
RUN_BOUNDED_PATH="${RUN_BOUNDED_LIB:-${BASH_SOURCE[0]%/*}/run-bounded.sh}"
# shellcheck source=/dev/null
if ! . "$RUN_BOUNDED_PATH" 2>/dev/null || ! command -v run_bounded >/dev/null 2>&1; then
  printf 'auto-format: cannot load %s; %s left unformatted\n' \
    "$RUN_BOUNDED_PATH" "${FILE_PATH##*/}" >&2
  exit 1
fi
# Per formatter, in seconds. Two of them run for a .py file, and both have to finish
# inside the hook's own 30s.
FMT_TIMEOUT_S="${AUTO_FORMAT_TIMEOUT_S:-12}"

# Formatters stay optional — a machine with no Go toolchain should still be able to edit a
# .go file. What was wrong is that a skip looked exactly like a successful format: prettier
# is absent on this host, so every .js/.json/.yaml/.md edit silently went unformatted and
# nothing said so. Report a miss once per tool per day — enough to notice, not enough to nag.
_fmt_state="${XDG_STATE_HOME:-$HOME/.local/state}/claude-auto-format"

run_if_installed() {
  if command -v "$1" >/dev/null 2>&1; then
    run_bounded "$FMT_TIMEOUT_S" 1048576 -- "$@"
    # A formatter's own non-zero exit stays quiet, as it always has. One that was cut off
    # did not format the file, and may have left it half-written, so that is said.
    if [ "$RB_STATUS" != ok ]; then
      printf 'auto-format: %s did not finish on %s within %ss (%s); check the file\n' \
        "$1" "${FILE_PATH##*/}" "$FMT_TIMEOUT_S" "$RB_STATUS" >&2
    fi
    return 0
  fi
  # One marker per tool, refreshed daily, so the directory stays bounded instead of
  # growing a file per tool per day.
  local marker="$_fmt_state/missing-$1"
  if [ -e "$marker" ] && [ -z "$(find "$marker" -mmin +1440 2>/dev/null)" ]; then
    return 0
  fi
  mkdir -p "$_fmt_state" 2>/dev/null || return 0
  : > "$marker" 2>/dev/null
  printf 'auto-format: %s is not installed; %s left unformatted\n' \
    "$1" "${FILE_PATH##*/}" >&2
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
    # Skip vault markdown — Obsidian formatting (wikilinks, callouts) is non-standard.
    # The vault location is machine-specific; CLAUDE_VAULT_DIR (from local.env) supplies
    # it when present. With no vault configured, all markdown is formatted normally.
    _skip_md=false
    if [ -n "${CLAUDE_VAULT_DIR:-}" ]; then
      case "$FILE_PATH" in
        "$CLAUDE_VAULT_DIR"/*) _skip_md=true ;;
      esac
    fi
    if [ "$_skip_md" = false ]; then
      run_if_installed prettier --write --log-level=silent "$FILE_PATH" >/dev/null
    fi
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
