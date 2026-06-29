#!/bin/bash
# Resolve which settings JSON the sandbox should mount.
# Usage: resolve-sandbox-settings.sh <base.json> <work-overlay.json>
# If the overlay exists, deep-merge base+overlay via claude-settings-merge and print
# the path to the merged temp file; otherwise (or on any failure) print the base path.
# Never fails the caller — a missing/broken merge tool falls back to the base.
set -u

BASE="$1"
OVERLAY="$2"

if [ ! -f "$OVERLAY" ]; then
  printf '%s\n' "$BASE"
  exit 0
fi

MERGE="$(command -v claude-settings-merge 2>/dev/null || true)"
if [ -z "$MERGE" ] && [ -x "$HOME/.local/bin/claude-settings-merge" ]; then
  MERGE="$HOME/.local/bin/claude-settings-merge"
fi
if [ -z "$MERGE" ]; then
  echo "resolve-sandbox-settings: claude-settings-merge not found; mounting base only" >&2
  printf '%s\n' "$BASE"
  exit 0
fi

_TMP="$(mktemp "${TMPDIR:-/tmp}/sandbox-settings-XXXXXX")"
OUT="${_TMP}.json"
mv "$_TMP" "$OUT"
if "$MERGE" "$BASE" "$OVERLAY" >"$OUT" 2>/dev/null; then
  printf '%s\n' "$OUT"
else
  echo "resolve-sandbox-settings: merge failed; mounting base only" >&2
  rm -f "$OUT"
  printf '%s\n' "$BASE"
fi
