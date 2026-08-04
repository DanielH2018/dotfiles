#!/bin/bash
# Resolve which settings JSON the sandbox should mount.
# Usage: resolve-sandbox-settings.sh <base.json> <work-overlay.json> [<host-settings.json>]
#
# Step 1 — fold a SAFE SUBSET of the host settings into the base (when a host
# settings path is given and readable). Host config changes should reach the
# sandbox as far as is safe, but wholesale sync would weaken container isolation,
# so only these keys cross:
#   - permissions.deny : union(base, host) — denies are additive; host protections
#                        also apply in-container and sandbox-specific denies survive.
#   - outputStyle / model / enabledPlugins / effortLevel : host value wins (behavioral
#     prefs), except the `remember` plugin, which is dropped: its memory store lives
#     outside the container's writable mounts, so its SessionStart hook errors on
#     every sandbox launch, and ephemeral sessions shouldn't accumulate memory.
#     effortLevel is folded rather than left settable in-container because settings.json
#     is bind-mounted read-only there — the in-session effort-level writer needs an
#     atomic rename onto that path, which always fails with EBUSY (can't rename onto
#     a mountpoint), so the only way to change it is via the host and this fold.
# Everything else from host is IGNORED. In particular permissions.allow (would
# widen what the sandboxed agent may do) and hooks (the sandbox ships its own
# container hook set) are deliberately NOT propagated.
#
# Step 2 — deep-merge the optional work overlay on top via claude-settings-merge
# (unchanged behavior).
#
# Never fails the caller — any missing input or tool failure falls back to the
# most-complete settings produced so far (host-folded base, else plain base).
set -u

BASE="$1"
OVERLAY="$2"
HOST="${3:-}"

# --- Step 1: fold host-safe subset into base ---
CUR="$BASE"
if [ -n "$HOST" ] && [ -f "$HOST" ] && command -v jq >/dev/null 2>&1; then
  _HTMP="$(mktemp "${TMPDIR:-/tmp}/sandbox-host-XXXXXX")"
  HOUT="${_HTMP}.json"
  mv "$_HTMP" "$HOUT"
  if jq -s '
        .[0] as $base | .[1] as $host
        | $base
        | .permissions.deny = ((($base.permissions.deny // []) + ($host.permissions.deny // [])) | unique)
        | (if $host.outputStyle    then .outputStyle    = $host.outputStyle    else . end)
        | (if $host.model          then .model          = $host.model          else . end)
        | (if $host.effortLevel    then .effortLevel    = $host.effortLevel    else . end)
        | (if $host.enabledPlugins then .enabledPlugins = ($host.enabledPlugins | del(.["remember@claude-plugins-official"])) else . end)
      ' "$BASE" "$HOST" >"$HOUT" 2>/dev/null && [ -s "$HOUT" ]; then
    CUR="$HOUT"
  else
    echo "resolve-sandbox-settings: host-safe fold failed; using base only" >&2
    rm -f "$HOUT"
  fi
fi

# --- Step 2: merge work overlay on top ---
if [ ! -f "$OVERLAY" ]; then
  printf '%s\n' "$CUR"
  exit 0
fi

MERGE="$(command -v claude-settings-merge 2>/dev/null || true)"
if [ -z "$MERGE" ] && [ -x "$HOME/.local/bin/claude-settings-merge" ]; then
  MERGE="$HOME/.local/bin/claude-settings-merge"
fi
if [ -z "$MERGE" ]; then
  echo "resolve-sandbox-settings: claude-settings-merge not found; mounting host-folded base" >&2
  printf '%s\n' "$CUR"
  exit 0
fi

_TMP="$(mktemp "${TMPDIR:-/tmp}/sandbox-settings-XXXXXX")"
OUT="${_TMP}.json"
mv "$_TMP" "$OUT"
# claude-settings-merge asserts the host's floor-deny list by default. That floor is a
# property of the HOST's ~/.claude/settings.json, not of a sandbox fragment: the sandbox
# carries its own permission model and runs --dangerously-skip-permissions, so no host hook
# fires in there anyway. Exempt it explicitly rather than leaving the generic tool to guess —
# and note the `2>/dev/null` below, which is why an unmet assertion here would otherwise be
# an invisible fallback to the un-merged base rather than a visible failure.
if CLAUDE_SETTINGS_SKIP_FLOOR=1 "$MERGE" "$CUR" "$OVERLAY" >"$OUT" 2>/dev/null; then
  # The step-1 host-fold temp is now superseded and nothing else references it.
  # Only remove it if it IS a temp we made — $CUR is $BASE when the fold was
  # skipped or failed, and $BASE is the caller's real settings.base.json.
  if [ "$CUR" != "$BASE" ]; then
    rm -f "$CUR"
  fi
  printf '%s\n' "$OUT"
else
  echo "resolve-sandbox-settings: merge failed; mounting host-folded base" >&2
  rm -f "$OUT"
  printf '%s\n' "$CUR"
fi
