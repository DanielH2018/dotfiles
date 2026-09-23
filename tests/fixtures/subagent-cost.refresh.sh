#!/usr/bin/env bash
# Rewrite tests/fixtures/subagent-cost.json from live telemetry (#578).
#
#   bash tests/fixtures/subagent-cost.refresh.sh
#
# Runs six LogQL instant queries through otelq over the last 7 days and writes their raw
# rows, the queries themselves and the evaluation date into the fixture, keeping its
# _comment. Needs otelq on PATH and Loki reachable. After a refresh, rewrite the
# agent_summary paragraph in skills/orchestrating-subagents/SKILL.md in the same commit;
# tests/subagent-cost.test.js lists every literal it now has to carry.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FIXTURE="$HERE/subagent-cost.json"
SEL='{service_name="claude-code"}'
KEYS="cost_usd_by_query_source requests_by_query_source subagent_completed_by_is_async
agent_summary_input_tokens agent_summary_cache_read_tokens agent_summary_output_tokens"

query_for() {
  case "$1" in
    cost_usd_by_query_source)
      printf 'sum by (query_source) (sum_over_time(%s | event_name="api_request" | unwrap cost_usd [7d]))' "$SEL" ;;
    requests_by_query_source)
      printf 'sum by (query_source) (count_over_time(%s | event_name="api_request" [7d]))' "$SEL" ;;
    subagent_completed_by_is_async)
      printf 'sum by (is_async) (count_over_time(%s | event_name="subagent_completed" [7d]))' "$SEL" ;;
    agent_summary_*_tokens)
      _field=${1#agent_summary_}
      printf 'sum(sum_over_time(%s | event_name="api_request" | query_source="agent_summary" | unwrap %s [7d]))' \
        "$SEL" "$_field" ;;
  esac
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# One object per key: {key, query, response}. jq slurps them into the fixture below.
for k in $KEYS; do
  q=$(query_for "$k")
  otelq logs --since 7d "$q" > "$TMP/$k.response"
  jq -n --arg key "$k" --arg query "$q" --slurpfile r "$TMP/$k.response" \
    '{key: $key, query: $query, response: $r[0]}' > "$TMP/$k.part"
done

jq -s --slurpfile old "$FIXTURE" '
  (map({(.key): .}) | add) as $p
  | def rows($k; $label): [$p[$k].response.data.result[]
      | {key: (.metric[$label] // "all"), value: .value[1]}] | sort_by(.key) | from_entries;
    def total($k): $p[$k].response.data.result[0].value[1];
    ($p.cost_usd_by_query_source.response.data.result[0].value[0]) as $at
  | {
      _comment: $old[0]._comment,
      measured: ($at | floor | strftime("%Y-%m-%d")),
      window: "7d",
      window_end_epoch: $at,
      queries: (map({(.key): .query}) | add),
      cost_usd_by_query_source: rows("cost_usd_by_query_source"; "query_source"),
      requests_by_query_source: rows("requests_by_query_source"; "query_source"),
      subagent_completed_by_is_async: rows("subagent_completed_by_is_async"; "is_async"),
      agent_summary_tokens: {
        input: total("agent_summary_input_tokens"),
        cache_read: total("agent_summary_cache_read_tokens"),
        output: total("agent_summary_output_tokens")
      }
    }' "$TMP"/*.part > "$TMP/fixture.json"
mv "$TMP/fixture.json" "$FIXTURE"
