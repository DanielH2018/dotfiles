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

test_guard_refuses_main() {
  local d; d="$(mk_repo)"
  if (cd "$d" && bash "$TRIAGE" guard-branch) 2>/dev/null; then
    fail "guard-branch should refuse on main"
  else
    pass "guard-branch refuses main"
  fi
}
test_guard_allows_feature() {
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/x
  if (cd "$d" && bash "$TRIAGE" guard-branch) 2>/dev/null; then
    pass "guard-branch allows feature branch"
  else
    fail "guard-branch should allow feature/x"
  fi
}
test_guard_refuses_main
test_guard_allows_feature

# Resolved default branch is 'trunk' (neither literal 'main' nor 'master').
# Discriminates the `[ "$cur" = "$def" ]` disjunct in guard_branch: if it were
# dropped, guard-branch would exit 0 (allow) on trunk since trunk matches
# neither literal check, failing this assertion.
test_guard_refuses_resolved_default() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b trunk
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local o; o="$(new_tmpdir)"
  git -C "$o" init -q --bare
  git -C "$d" remote add origin "$o"
  git -C "$d" push -q origin trunk
  git -C "$d" remote set-head origin trunk
  if (cd "$d" && bash "$TRIAGE" guard-branch) 2>/dev/null; then
    fail "guard-branch should refuse on resolved default branch 'trunk'"
  else
    pass "guard-branch refuses resolved default branch 'trunk'"
  fi
}
test_guard_refuses_resolved_default

mk_noisy_branch() {
  # feature branch: 3 clean commits + 1 fixup + 1 merge commit off main
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/noisy
  for n in 1 2 3; do
    echo "$n" > "$d/f$n.txt"; git -C "$d" add "f$n.txt"
    git -C "$d" commit -q -m "Add feature part $n"
  done
  echo x >> "$d/f1.txt"; git -C "$d" add f1.txt
  git -C "$d" commit -q -m "fixup: address review comments"
  # create a divergent main commit and merge it, producing a merge commit
  git -C "$d" checkout -q main; echo m > "$d/m.txt"; git -C "$d" add m.txt
  git -C "$d" commit -q -m "main moves"
  git -C "$d" checkout -q feature/noisy
  git -C "$d" merge -q --no-ff -m "Merge branch 'main' into feature/noisy" main
  echo "$d"
}

test_metrics_flags() {
  local d; d="$(mk_noisy_branch)"
  local out; out="$(cd "$d" && bash "$TRIAGE" metrics 1)"
  echo "$out" | grep -q "merges=1" && pass "metrics counts merge" || fail "merges: $out"
  echo "$out" | grep -q "fixups=1" && pass "metrics counts fixup" || fail "fixups: $out"
  echo "$out" | grep -q "needs_history_cleanup=true" && pass "flags cleanup" || fail "cleanup: $out"
}
test_metrics_flags

[ "$FAILS" -eq 0 ] || { echo "$FAILS test(s) failed"; exit 1; }
echo "all passed"
