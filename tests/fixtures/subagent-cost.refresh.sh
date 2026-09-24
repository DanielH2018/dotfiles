#!/usr/bin/env bash
# Rewrite tests/fixtures/subagent-cost.json from live telemetry (#578, #611).
#
#   bash tests/fixtures/subagent-cost.refresh.sh [OUT]
#
# `otelq savings subagents` owns the six LogQL queries and the row shaping; this script
# only keeps the fixture's _comment and writes the file. It runs this checkout's otelq,
# not the one on PATH, so a refresh reflects the reviewed report even before a deploy.
# Needs Loki reachable. OUT defaults to the fixture; pass another path to look at a
# refresh without replacing the snapshot. After a real refresh, rewrite the agent_summary
# paragraph in skills/orchestrating-subagents/SKILL.md in the same commit;
# tests/subagent-cost.test.js lists every literal it now has to carry.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FIXTURE="$HERE/subagent-cost.json"
OTELQ="$HERE/../../home/dot_local/bin/executable_otelq"
OUT=${1:-$FIXTURE}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

python3 "$OTELQ" savings subagents --since 7d > "$TMP/report.json"
jq --slurpfile old "$FIXTURE" '{_comment: $old[0]._comment} + del(.report)' \
  "$TMP/report.json" > "$TMP/fixture.json"
mv "$TMP/fixture.json" "$OUT"
