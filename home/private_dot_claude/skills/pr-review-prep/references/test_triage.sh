#!/usr/bin/env bash
# shellcheck disable=SC2015  # `[ cond ] && pass || fail` harness idiom: pass() always returns 0
set -euo pipefail
# NOTE: run with the Claude Code bash sandbox disabled — git config-locking
# and mktemp restrictions under the sandbox can produce false failures here.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRIAGE="$HERE/triage.sh"
FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS+1)); }

TMPROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

# Hand out subdirectories of the single root rather than registering each one in
# an array: every caller invokes this as `d="$(new_tmpdir)"`, and a command
# substitution runs in a subshell, so an array append here would be discarded
# with that subshell and cleanup would delete nothing.
new_tmpdir() {
  mktemp -d "$TMPROOT/XXXXXX"
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
  echo "$out" | grep -qx "merges=1" && pass "metrics counts merge" || fail "merges: $out"
  echo "$out" | grep -qx "fixups=1" && pass "metrics counts fixup" || fail "fixups: $out"
  echo "$out" | grep -qx "needs_history_cleanup=true" && pass "flags cleanup" || fail "cleanup: $out"
}
test_metrics_flags

# feature branch: 11 commits, each adding one new file (11 changed files vs
# merge-base with main), no merges, no fixup-like subjects. This exceeds the
# files>10 AND commits>6 thresholds simultaneously so we can isolate the
# `groups>=2` conjunct by only varying the `groups` argument between calls.
mk_big_branch() {
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/big
  local n
  for n in $(seq 1 11); do
    echo "$n" > "$d/big$n.txt"; git -C "$d" add "big$n.txt"
    git -C "$d" commit -q -m "Add big file $n"
  done
  echo "$d"
}

test_metrics_split_worthy() {
  local d; d="$(mk_big_branch)"
  local out2; out2="$(cd "$d" && bash "$TRIAGE" metrics 2)"
  echo "$out2" | grep -qx "split_worthy=true" && pass "split_worthy true when size exceeded and groups>=2" || fail "split_worthy(groups=2): $out2"

  local out1; out1="$(cd "$d" && bash "$TRIAGE" metrics 1)"
  echo "$out1" | grep -qx "split_worthy=false" && pass "split_worthy false when groups=1 (same branch)" || fail "split_worthy(groups=1): $out1"
  echo "$out1" | grep -qx "files=11" && pass "metrics counts files" || fail "files: $out1"
  echo "$out1" | grep -qx "commits=11" && pass "metrics counts commits" || fail "commits: $out1"
}
test_metrics_split_worthy

test_backup_and_tree_equal() {
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/te
  echo a > "$d/a.txt"; git -C "$d" add a.txt; git -C "$d" commit -q -m "a"
  echo b > "$d/b.txt"; git -C "$d" add b.txt; git -C "$d" commit -q -m "b"
  local ref; ref="$(cd "$d" && bash "$TRIAGE" backup)"
  echo "$ref" | grep -q "^backup/feature-te-" && pass "backup ref named" || fail "backup: $ref"
  # squash the two commits: tree unchanged -> assert passes
  git -C "$d" reset -q --soft HEAD~2; git -C "$d" commit -q -m "a+b squashed"
  if (cd "$d" && bash "$TRIAGE" assert-tree-equal "$ref") 2>/dev/null; then
    pass "tree-equal after squash"
  else
    fail "tree-equal should hold after squash"
  fi
  # now change the tree -> assert fails
  echo c > "$d/c.txt"; git -C "$d" add c.txt; git -C "$d" commit -q -m "c"
  if (cd "$d" && bash "$TRIAGE" assert-tree-equal "$ref") 2>/dev/null; then
    fail "tree-equal should fail after real change"
  else
    pass "tree-equal detects real change"
  fi
}
test_backup_and_tree_equal

test_backup_sanitizes_slash_branch() {
  local d; d="$(mk_repo)"
  # Occupy the 'backup/feature' namespace as a plain branch, so that an
  # unsanitized ref path (refs/heads/backup/feature/x-<sha>) would nest under
  # it and git update-ref would fail hard with exit 128.
  git -C "$d" branch backup/feature main
  git -C "$d" checkout -q -b feature/x
  echo z > "$d/z.txt"; git -C "$d" add z.txt; git -C "$d" commit -q -m "z"
  local ref rc
  ref="$(cd "$d" && bash "$TRIAGE" backup)" && rc=0 || rc=$?
  [ "$rc" -eq 0 ] && pass "backup succeeds despite backup/feature collision" \
    || fail "backup should succeed (exit 0), got exit $rc"
  echo "$ref" | grep -q "^backup/feature-x-" && pass "backup ref sanitized for slash branch" \
    || fail "backup sanitized ref: $ref"
}
test_backup_sanitizes_slash_branch

# feature branch: 2 clean commits, no merges, no fixup-like subjects, few
# commits (<=6). Discriminates the negative case of needs_history_cleanup:
# if any disjunct in `[ merges>0 ] || [ fixups>0 ] || [ commits>6 ]` were
# wrongly tripped by ordinary commits, this would flip to true.
mk_clean_small_branch() {
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/clean
  echo a > "$d/a.txt"; git -C "$d" add a.txt
  git -C "$d" commit -q -m "Add a"
  echo b > "$d/b.txt"; git -C "$d" add b.txt
  git -C "$d" commit -q -m "Add b"
  echo "$d"
}

test_metrics_clean_small_branch_no_cleanup() {
  local d; d="$(mk_clean_small_branch)"
  local out; out="$(cd "$d" && bash "$TRIAGE" metrics 1)"
  echo "$out" | grep -qx "needs_history_cleanup=false" \
    && pass "needs_history_cleanup=false on clean small branch" \
    || fail "needs_history_cleanup on clean small branch: $out"
  echo "$out" | grep -qx "merges=0" && pass "clean branch has no merges" || fail "merges: $out"
  echo "$out" | grep -qx "fixups=0" && pass "clean branch has no fixups" || fail "fixups: $out"
}
test_metrics_clean_small_branch_no_cleanup

# feature branch: a single commit whose diff exceeds 400 changed lines, but
# with few files (<=10) and few commits (<=6) -- isolates the `net>400`
# disjunct of split_worthy's size check from the `files>10` and `commits>6`
# disjuncts, which are both false here.
mk_large_diff_branch() {
  local d; d="$(mk_repo)"
  git -C "$d" checkout -q -b feature/largediff
  seq 1 500 > "$d/big.txt"
  git -C "$d" add big.txt
  git -C "$d" commit -q -m "Add large file"
  echo "$d"
}

test_metrics_split_worthy_net_over_400() {
  local d; d="$(mk_large_diff_branch)"
  local out2; out2="$(cd "$d" && bash "$TRIAGE" metrics 2)"
  echo "$out2" | grep -qx "files=1" && pass "large-diff branch has 1 file" || fail "files: $out2"
  echo "$out2" | grep -qx "commits=1" && pass "large-diff branch has 1 commit" || fail "commits: $out2"
  echo "$out2" | grep -qx "net=500" && pass "large-diff branch net=500" || fail "net: $out2"
  echo "$out2" | grep -qx "split_worthy=true" \
    && pass "split_worthy true via net>400 disjunct when groups>=2" \
    || fail "split_worthy(net>400,groups=2): $out2"

  local out1; out1="$(cd "$d" && bash "$TRIAGE" metrics 1)"
  echo "$out1" | grep -qx "split_worthy=false" \
    && pass "split_worthy false when groups=1 despite net>400" \
    || fail "split_worthy(net>400,groups=1): $out1"
}
test_metrics_split_worthy_net_over_400

# No 'origin' remote at all, so origin/<default> can never resolve -- metrics
# must degrade gracefully with a clear stderr message and a distinct exit
# code, not a raw `git merge-base` fatal error under `set -e`.
test_metrics_missing_origin_default_guard() {
  local d; d="$(new_tmpdir)"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@t.co; git -C "$d" config user.name t
  git -C "$d" commit -q --allow-empty -m init
  local out rc
  out="$(cd "$d" && bash "$TRIAGE" metrics 1 2>&1)" && rc=0 || rc=$?
  [ "$rc" -eq 3 ] && pass "metrics exits 3 when origin/<default> missing" \
    || fail "metrics missing-origin exit code: got $rc"
  echo "$out" | grep -q "run 'git fetch origin' first" \
    && pass "metrics missing-origin prints guard message" \
    || fail "metrics missing-origin message: $out"
}
test_metrics_missing_origin_default_guard

test_assert_tree_equal_missing_ref() {
  local d; d="$(mk_repo)"
  local out rc
  out="$(cd "$d" && bash "$TRIAGE" assert-tree-equal nonexistent-ref-xyz 2>&1)" && rc=0 || rc=$?
  [ "$rc" -eq 1 ] && pass "assert-tree-equal missing ref exits 1" \
    || fail "assert-tree-equal missing ref should exit 1, got exit $rc"
  echo "$out" | grep -q "not found" && pass "assert-tree-equal missing ref message accurate" \
    || fail "assert-tree-equal missing ref message: $out"
  echo "$out" | grep -q "altered content" && fail "assert-tree-equal missing ref should not print misleading 'altered content' message" \
    || pass "assert-tree-equal missing ref does not print misleading message"
}
test_assert_tree_equal_missing_ref

[ "$FAILS" -eq 0 ] || { echo "$FAILS test(s) failed"; exit 1; }
echo "all passed"
