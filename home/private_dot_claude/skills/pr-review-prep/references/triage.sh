#!/usr/bin/env bash
set -euo pipefail

default_branch() {
  local ref
  if ref="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)"; then
    echo "${ref#origin/}"; return 0
  fi
  if git show-ref --verify -q refs/remotes/origin/main; then echo main; return 0; fi
  if git show-ref --verify -q refs/remotes/origin/master; then echo master; return 0; fi
  echo main
}

cmd="${1:-}"; shift || true
case "$cmd" in
  default-branch) default_branch "$@" ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 2 ;;
esac
