#!/usr/bin/env bash
set -euo pipefail
# NOTE: run with the Claude Code bash sandbox disabled — git config-locking
# and mktemp restrictions under the sandbox can produce false failures here.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE="$HERE/triage.sh"
FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS+1)); }

TMPDIRS=()
cleanup() { [ "${#TMPDIRS[@]}" -eq 0 ] || rm -rf "${TMPDIRS[@]}"; }
trap cleanup EXIT

new_tmpdir() {
  local d; d="$(mktemp -d)"
  TMPDIRS+=("$d")
  echo "$d"
}

# Build a scratch repo with a fake 'origin' remote whose HEAD points at main.
mk_repo() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local o; o="$(new_tmpdir)"
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

# Both origin/main and origin/master exist, no symbolic origin/HEAD -> only
# the `show-ref origin/main` check (ordered first) can produce "main"; if it
# were removed or reordered after the origin/master check, this would
# instead resolve to "master", failing the assertion below.
test_default_branch_main_fallback() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local o; o="$(new_tmpdir)"
  git -C "$o" init -q --bare
  git -C "$d" remote add origin "$o"
  git -C "$d" push -q origin main
  git -C "$d" branch master main
  git -C "$d" push -q origin master
  local got; got="$(cd "$d" && bash "$TRIAGE" default-branch)"
  [ "$got" = "main" ] && pass "default-branch main-fallback=main" || fail "default-branch main-fallback got '$got'"
}
test_default_branch_main_fallback

# origin/master exists, no origin/main, no symbolic origin/HEAD -> falls back
# to the `show-ref origin/master` check.
test_default_branch_master_fallback() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b master
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local o; o="$(new_tmpdir)"
  git -C "$o" init -q --bare
  git -C "$d" remote add origin "$o"
  git -C "$d" push -q origin master
  local got; got="$(cd "$d" && bash "$TRIAGE" default-branch)"
  [ "$got" = "master" ] && pass "default-branch master-fallback=master" || fail "default-branch master-fallback got '$got'"
}
test_default_branch_master_fallback

# No 'origin' remote at all -> resolves to the literal 'main' fallback.
test_default_branch_no_remote() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b trunk
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local got; got="$(cd "$d" && bash "$TRIAGE" default-branch)"
  [ "$got" = "main" ] && pass "default-branch no-remote=main" || fail "default-branch no-remote got '$got'"
}
test_default_branch_no_remote

[ "$FAILS" -eq 0 ] || { echo "$FAILS test(s) failed"; exit 1; }
echo "all passed"
