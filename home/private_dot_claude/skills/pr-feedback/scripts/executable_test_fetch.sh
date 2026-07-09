#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$SCRIPT_DIR/fixtures"
pass=0; fail=0
assert_eq() {  # desc expected actual
  if [[ "$2" == "$3" ]]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual:   [$3]"; fi
}
run() { PR_FEEDBACK_FIXTURE="$FIX/$1" bash "$SCRIPT_DIR/fetch.sh"; }

out="$(run mixed.json)"
assert_eq "mixed total"            "3"        "$(jq -r '.counts.total' <<<"$out")"
assert_eq "mixed attention"        "2"        "$(jq -r '.counts.attention' <<<"$out")"
assert_eq "mixed sort order"       "10 20 30" "$(jq -r '[.prs[].number] | join(" ")' <<<"$out")"
assert_eq "mixed tiers"            "1 2 3"    "$(jq -r '[.prs[].tier] | join(" ")' <<<"$out")"
assert_eq "pr10 unresolved only"   "1"        "$(jq -r '.prs[]|select(.number==10)|.threads|length' <<<"$out")"
assert_eq "pr10 latest per author" "2"        "$(jq -r '.prs[]|select(.number==10)|.reviews|length' <<<"$out")"
assert_eq "pr10 alice latest"      "CHANGES_REQUESTED" "$(jq -r '.prs[]|select(.number==10)|.reviews[]|select(.author=="alice")|.state' <<<"$out")"
assert_eq "pr10 non-passing checks" "1"       "$(jq -r '.prs[]|select(.number==10)|.checks|length' <<<"$out")"

out="$(run failing.json)"
assert_eq "failing tier"            "1"       "$(jq -r '.prs[0].tier' <<<"$out")"
assert_eq "failing drops success"   "2"       "$(jq -r '.prs[0].checks|length' <<<"$out")"

out="$(run empty.json)"
assert_eq "empty total"             "0"       "$(jq -r '.counts.total' <<<"$out")"

echo "---"; echo "pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
