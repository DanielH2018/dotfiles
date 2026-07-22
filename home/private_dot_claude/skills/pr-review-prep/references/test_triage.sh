#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE="$HERE/triage.sh"
FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS+1)); }

# Build a scratch repo with a fake 'origin' remote whose HEAD points at main.
mk_repo() {
  local d; d="$(mktemp -d)"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local o; o="$(mktemp -d)"
  git -C "$o" init -q --bare
  git -C "$d" remote add origin "$o"
  git -C "$d" push -q origin main
  git -C "$d" remote set-head origin main
  echo "$d"
}

test_default_branch() {
  local d; d="$(mk_repo)"
  local got; got="$(cd "$d" && bash "$TRIAGE" default-branch)"
  [ "$got" = "main" ] && pass "default-branch=main" || fail "default-branch got '$got'"
}
test_default_branch

[ "$FAILS" -eq 0 ] || { echo "$FAILS test(s) failed"; exit 1; }
echo "all passed"
