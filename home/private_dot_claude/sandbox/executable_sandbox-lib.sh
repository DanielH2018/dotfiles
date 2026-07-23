#!/usr/bin/env bash
# sandbox-lib.sh — shared helpers sourced by claude-sandbox
# (lives in ~/.claude/sandbox). Sourced, not executed: define functions only,
# never run anything at load time or set shell options here.

# Map a bare repo name ("airflow") to ~/Repositories/airflow when that dir exists;
# leave absolute ("/x") and relative ("./x", "../x") paths untouched. Echoes the
# resolved path. Callers still normalize with `cd … && pwd` as their context needs
# (some fail-open with `|| exit 0`), so that step deliberately stays at the call site.
resolve_repo_path() {
  local p="$1"
  if [[ "$p" != /* && "$p" != .* && -d "$HOME/Repositories/$p" ]]; then
    printf '%s\n' "$HOME/Repositories/$p"
  else
    printf '%s\n' "$p"
  fi
}
