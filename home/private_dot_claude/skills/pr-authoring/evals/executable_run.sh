#!/usr/bin/env bash
# Trigger eval for the pr-authoring skill: does its description fire on the
# prompts it should, and stay quiet on the ones it should not?
#
# Graded by code, not by a model. Each run is `claude -p` restricted to the
# Skill tool, and the verdict is whether the stream carried a tool_use naming
# the skill. Binary and free.
#
# Two isolations make the number mean anything, and each was established by
# watching the eval report the wrong answer without it:
#   - a THROWAWAY CLAUDE_CONFIG_DIR holding only this skill and the peers it
#     must be told apart from. Under the real config, superpowers' "if there is
#     even a 1% chance a skill might apply you MUST invoke it" makes every
#     negative case fire something, and the number measures the harness.
#   - an EMPTY working directory. Claude Code loads the cwd's project CLAUDE.md,
#     and that context changes which skills fire: run from this repo, the
#     plainest positive case scored 0/3.
#
# Usage:  run.sh [--runs N] [--case NAME] [--model M]
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cases_file="$here/cases.json"

runs_override=""
case_filter=""
model_override=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) runs_override="$2"; shift 2 ;;
    --case) case_filter="$2"; shift 2 ;;
    --model) model_override="$2"; shift 2 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

for dep in claude jq; do
  command -v "$dep" >/dev/null || { echo "missing dependency: $dep" >&2; exit 69; }
done
[ -f "$cases_file" ] || { echo "no cases.json beside $0" >&2; exit 66; }

skill="$(jq -r '.skill' "$cases_file")"
model="${model_override:-$(jq -r '.model' "$cases_file")}"
runs="${runs_override:-$(jq -r '.runs' "$cases_file")}"

# --- isolated config ------------------------------------------------------
cfg="$(mktemp -d)"
trap 'rm -rf "$cfg"' EXIT
mkdir -p "$cfg/skills" "$cfg/cwd"
echo '{}' >"$cfg/settings.json"

# Credentials live in the real config dir and do not follow CLAUDE_CONFIG_DIR.
if [ -f "$HOME/.claude/.credentials.json" ]; then
  ln -s "$HOME/.claude/.credentials.json" "$cfg/.credentials.json"
fi

link_skill() {
  local name="$1" src=""
  if [ -d "$HOME/.claude/skills/$name" ]; then
    src="$HOME/.claude/skills/$name"
  else
    # Plugin skills sit under a versioned cache path that moves on update.
    src="$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -type d -name "$name" 2>/dev/null | head -1)"
  fi
  if [ -z "$src" ]; then
    echo "  note: peer skill '$name' not found; running without it" >&2
    return 0
  fi
  ln -s "$src" "$cfg/skills/$name"
}

link_skill "$skill"
[ -L "$cfg/skills/$skill" ] || { echo "skill under test '$skill' not installed" >&2; exit 66; }
while read -r peer; do link_skill "$peer"; done < <(jq -r '.peers[]' "$cases_file")

# One measured run. The cd happens inside the function's own subshell, so the
# runner's repo stays out of the measurement: Claude Code reads the cwd's
# project CLAUDE.md, and that context changes which skills fire.
# </dev/null stops `claude` consuming the case loop's stdin, which would
# otherwise swallow every remaining case.
one_run() {
  cd "$cfg/cwd" || return 0
  CLAUDE_CONFIG_DIR="$cfg" timeout 240 claude -p "$1" \
    --allowedTools "Skill" --model "$model" \
    --output-format stream-json --verbose </dev/null 2>/dev/null || true
}

# --- run ------------------------------------------------------------------
printf 'skill=%s  model=%s  runs=%s  peers=%s\n\n' \
  "$skill" "$model" "$runs" "$(jq -r '.peers | join(",")' "$cases_file")"
printf '%-22s %-7s %-7s %s\n' CASE EXPECT FIRED VERDICT
printf '%-22s %-7s %-7s %s\n' ---- ------ ----- -------

total=0; passed=0; failures=""
while read -r name expect input; do
  name="$(printf '%b' "$name")"; expect="$(printf '%b' "$expect")"
  input="$(printf '%b' "$input")"
  [ -z "$case_filter" ] || [ "$case_filter" = "$name" ] || continue

  fired=0
  for _ in $(seq 1 "$runs"); do
    out="$(one_run "$input")"
    # A herestring, never `printf ... | grep -q`. Under `set -o pipefail` grep
    # exits the moment it matches, printf takes SIGPIPE, and the pipeline
    # reports failure on a SUCCESSFUL match — scoring every hit as a miss.
    if grep -q "\"skill\":\"$skill\"" <<<"$out"; then
      fired=$((fired + 1))
    fi
  done

  # A description that fires must fire every run; one that should stay quiet
  # must stay quiet every run. An intermittent trigger is a failure, and the
  # rate is what says how bad.
  if [ "$expect" = "fires" ]; then
    [ "$fired" -eq "$runs" ] && verdict=pass || verdict=FAIL
  else
    [ "$fired" -eq 0 ] && verdict=pass || verdict=FAIL
  fi

  total=$((total + 1))
  if [ "$verdict" = pass ]; then
    passed=$((passed + 1))
  else
    failures="$failures  $name (expected $expect, fired $fired/$runs): $input"$'\n'
  fi
  printf '%-22s %-7s %-7s %s\n' "$name" "$expect" "$fired/$runs" "$verdict"
done < <(jq -r '.cases[] | [.name, .expect, .input] | @tsv' "$cases_file")

printf '\n%s/%s cases passed\n' "$passed" "$total"
if [ -n "$failures" ]; then
  printf '\nfailures:\n%s' "$failures"
  exit 1
fi
