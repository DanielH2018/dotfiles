#!/usr/bin/env bash
# Tests for render.sh: JSON validation, HTML-escaping of PR content so it can't
# break out of the <script> block, the exactly-one-marker guard, and rendering
# against the real shipped template.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$SCRIPT_DIR/render.sh"
[[ -f "$RENDER" ]] || RENDER="$SCRIPT_DIR/executable_render.sh"  # source tree, prefix not stripped
REAL_TEMPLATE="$SCRIPT_DIR/../templates/report.html"
MARK='/*__PR_FEEDBACK_DATA__*/null'
pass=0; fail=0

assert_eq() {  # desc expected actual
  if [[ "$2" == "$3" ]]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual:   [$3]"; fi
}
assert_contains() {  # desc needle haystack
  if [[ "$3" == *"$2"* ]]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $1"; echo "  expected to contain: [$2]"; fi
}
assert_absent() {  # desc needle haystack
  if [[ "$3" != *"$2"* ]]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $1"; echo "  should not contain: [$2]"; fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
one_marker() { printf 'const DATA = %s;\n' "$MARK" > "$1"; }

# 1. Happy path — valid JSON substituted, marker consumed, out path printed
one_marker "$TMP/one.html"
out="$(printf '%s' '{"ok":true}' | bash "$RENDER" "$TMP/one.html" "$TMP/one.out.html")"
assert_eq       "happy prints out path"  "$TMP/one.out.html"          "$out"
body="$(cat "$TMP/one.out.html")"
assert_contains "happy embeds data"      'const DATA = {"ok":true};'  "$body"
assert_absent   "happy marker consumed"  "$MARK"                      "$body"

# 2. PR content with HTML-significant chars is \u-escaped, never emitted raw,
#    so it cannot break out of the <script> block (injection guard).
one_marker "$TMP/xss.html"
payload='{"t":"</script><img src=x onerror=alert(1)> & done"}'
printf '%s' "$payload" | bash "$RENDER" "$TMP/xss.html" "$TMP/xss.out.html" >/dev/null
body="$(cat "$TMP/xss.out.html")"
assert_absent   "xss no raw </script>"   "</script>"  "$body"
assert_absent   "xss no raw <"           "<"          "$body"
assert_absent   "xss no raw >"           ">"          "$body"
assert_absent   "xss no raw &"           "&"          "$body"
assert_contains "xss < escaped (u003c)"  "u003c"      "$body"
assert_contains "xss > escaped (u003e)"  "u003e"      "$body"
assert_contains "xss & escaped (u0026)"  "u0026"      "$body"

# 3. Invalid JSON fails loudly and writes no output file
one_marker "$TMP/bad.html"; rm -f "$TMP/bad.out.html"
if printf 'not json' | bash "$RENDER" "$TMP/bad.html" "$TMP/bad.out.html" >/dev/null 2>&1; then rc=ok; else rc=fail; fi
assert_eq "invalid json exits non-zero"  "fail"    "$rc"
assert_eq "invalid json writes nothing"  "absent"  "$([[ -e "$TMP/bad.out.html" ]] && echo present || echo absent)"

# 4. Marker count must be exactly one — zero and many both fail
printf 'no marker at all\n' > "$TMP/zero.html"
if printf '{}' | bash "$RENDER" "$TMP/zero.html" "$TMP/zero.out.html" >/dev/null 2>&1; then rc=ok; else rc=fail; fi
assert_eq "zero markers exits non-zero"  "fail"  "$rc"
printf 'const A=%s; const B=%s;\n' "$MARK" "$MARK" > "$TMP/two.html"
if printf '{}' | bash "$RENDER" "$TMP/two.html" "$TMP/two.out.html" >/dev/null 2>&1; then rc=ok; else rc=fail; fi
assert_eq "two markers exits non-zero"   "fail"  "$rc"

# 5. Integration — the shipped template has exactly one marker and renders clean
if [[ -f "$REAL_TEMPLATE" ]]; then
  out="$(printf '%s' '{"counts":{"total":0},"prs":[]}' | bash "$RENDER" "$REAL_TEMPLATE" "$TMP/real.out.html")"
  assert_eq       "real template renders"         "$TMP/real.out.html"  "$out"
  body="$(cat "$TMP/real.out.html")"
  assert_contains "real template embeds data"     '"total":0'           "$body"
  assert_absent   "real template marker consumed" "$MARK"               "$body"
else
  fail=$((fail+1)); echo "FAIL: real template missing at $REAL_TEMPLATE"
fi

echo "---"; echo "pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
