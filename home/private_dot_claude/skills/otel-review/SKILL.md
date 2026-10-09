---
name: otel-review
description: Use when reviewing, auditing or debugging Claude Code OTEL telemetry across the machines — this PC, daniel-box, daniel-server. Covers pipeline health, sessions that export nowhere, then — unprompted, once the pipeline is healthy — analysis of the data itself: spend, cache efficiency, api_error and tool-failure rates, hook failures, MCP connection churn, compaction, and the tooling-rule savings. Triggers on "review the OTEL logs", "check telemetry", "analyse the telemetry", "is anything not exporting", "why is Loki empty".
---

# otel-review

A run has two phases, and the second follows the first without asking:

```
1. Health   — otel-sweep --deep --rows; is every machine exporting?
     │
     ├─ any fault ──► report the faults (## Report). Offer the analysis in one line.
     │
     └─ all healthy ─► 2. Analyse — run every step in ## Analyse the data, then report both.
```

The user asking for a review is the ask for the analysis. Do not stop after a clean health
check to ask whether to look at the data. A health report that says "all three healthy" and
nothing else is an unfinished run.

## Gather

```bash
otel-sweep --rows          # fast: health, volume, errors, per machine
otel-sweep --deep --rows   # adds sessions that are exporting nowhere
otel-sweep --deep          # same, as JSON, when you need a field the table drops
```

One command reaches all three machines and needs no prompt.

For a follow-up query on **this** PC, `otelq` is the way in. It is allowlisted, so none of
these prompt:

```bash
otelq ready                                            # readiness of both backends
otelq logs '<LogQL>' --rows                            # instant query against Loki
otelq logs '<LogQL>' --stream --since 24h --limit 5    # range query; also --direction
otelq metric '<PromQL>' --stream --since 30m --step 60 # PromQL against Prometheus
otelq labels                                           # label names, or values for one
```

Never `curl` the Loki or Prometheus HTTP API. `otelq` covers every query shape those
endpoints take, and `curl` stays ask-listed on purpose — a prefix rule cannot constrain what
follows a URL, so each call costs a prompt. A real run of this skill spent six prompts, all
of them curl, every one expressible as `otelq`.

Summarize sweep JSON with `jsonq`, or `jq` for a plain path extraction. Both are allowlisted.
A `python3 -` heredoc is not, and the secrets hook blocks it outright — `jsonq` is the tool
that exists to absorb that reflex, being a closed subset of Python syntax. Its one surprise
is that there is no attribute access: `items(d)` not `d.items()`, `get(d, k, default)` not
`d.get(...)`, `values(d)` not `d.values()`. `jsonq --functions` prints everything callable.

There is no unprompted ad-hoc query path to the other two machines, and that is deliberate —
see the grant comment in `settings.permissions.json`.

Run `--deep` for the health phase. Silent sessions are invisible to the fast pass by
construction, so a clean `--rows` pass cannot clear the gate into the analysis. Use the fast
pass alone only when the question is narrower than a review, such as "is daniel-box
exporting".

## The three machines are not alike

| | backends | reached by |
|---|---|---|
| this PC | docker compose | 127.0.0.1 |
| daniel-box | k3s, `observability` ns | 127.0.0.1 hostPort, else the ClusterIP |
| daniel-server | the same cluster, same namespace | 127.0.0.1 hostPort, else the ClusterIP |

**Which cluster node holds the query backends is not fixed.** Loki, Prometheus and Tempo are
single-replica Deployments with no `nodeSelector`. They publish their query ports on a
`hostPort` bound to `127.0.0.1`, so whichever node they land on is the only node whose
loopback answers — and a reboot moves that. On 2026-08-23 all three moved from daniel-box to
daniel-server, and every loopback probe from daniel-box read `unreachable` while the
telemetry itself was completely healthy. `otelq` and `otel-sweep` now fall back to the
ClusterIP, which is routed on every node, so both work from either machine.

Do not carry a belief about where they run. Ask:

```bash
kubectl get pods -n observability -o wide
```

Both nodes run the `otel-collector` DaemonSet pod, binding `hostPort 4317` on `127.0.0.1`,
and both forward into the same Loki — so a node's events are in the totals whether or not
that node holds a query backend. History survives the move too: the collectors reach Loki by
ClusterIP rather than a host port, and the PVCs are Longhorn RWO, so a reschedule costs the
query path and nothing else. Nothing in the pipeline records a hostname, so split them
by kernel:

```
sum by (os_version) (count_over_time({service_name="claude-code"}[24h]))
```

Map each `os_version` to a machine with `kubectl get nodes -o wide`, which prints the live
kernel per node. Never hardcode the kernel strings — they change at every upgrade, and a
query pinned to an old one returns nothing, which reads as "that machine stopped exporting".
To prove a node still exports, check its kernel's share is non-zero, or test its collector
directly with `/dev/tcp/127.0.0.1/4317`.

Running the sweep **on** one of these machines is normal: `otel-sweep` skips the ssh hop to
itself and reports it as `local`, so there is no row for the machine you are sitting on.

For anything deeper on daniel-box, the authority is
`~/server/ansible/roles/k8s/claude-otel/CLAUDE.md` **on that host** — read it rather than
restating it here, so the two cannot drift.

## Writing the query

Four shapes return a well-formed result that is wrong rather than an error, so they read as
"nothing to report" and end the investigation. All four did exactly that on 2026-08-23; the
first two hid 116 real hook failures, and the last two inverted a headline finding.

**`event_name` and `session_id` are structured metadata, not stream labels.** They select
nothing inside `{...}` and must be filtered after a pipe:

```
{service_name="claude-code"} | event_name="compaction"          # correct
{service_name="claude-code", event_name="compaction"}           # matches no stream, returns []
```

The stream selector holds `service_name` and little else. When unsure which a field is, name
it in a `sum by (...)` over the bare selector — a field that aggregates is present, whatever
side of the pipe it belongs on.

**Check an event name exists before filtering on one.** The names are not the ones you would
guess, and a wrong one is indistinguishable from a real zero. Enumerate first:

```
sum by (event_name) (count_over_time({service_name="claude-code"}[24h]))
```

The hook completion event is `hook_execution_complete`, not `hook_execution_end`.

**`savings reduction` and `savings trend` read local files**, not Loki — they parse
`~/.local/share/claude-metrics/` on whichever machine runs them. Run over ssh against the
node holding Loki, they report zero for the machine that did the work. Run those two on the
machine being measured; every other `savings` subcommand goes where Loki is.

**`savings prompts` truncates at 5000 events** and says so in a row that is easy to skim
past. At `--since 7d` it reported 210 prompts against a true 487. For a count, aggregate
`tool_decision` by `source`; keep `savings prompts` for composition, at `--since 24h`.

## Reading the result

Judge each machine against what it should look like, then report only what departs.

- **Zero events is not automatically a fault.** A machine with no sessions since the window
  opened is idle, not broken. Confirm before calling it: compare against the transcripts
  under `~/.claude/projects`. `--deep` does this for you.
- **Transcript mtime is not session activity.** Things that are not the session re-stamp
  those files — a retention sweep touched four transcripts from 2026-08-18/19 on 2026-08-23,
  and each then looked like a live session holding zero events, which is the exact shape of a
  silent session. Read the last `"timestamp"` in the file's own content instead. `--deep`
  does this now; do it by hand too if you are checking a candidate yourself.
- **A silent session is the finding that matters.** A transcript being written while Loki
  holds none of its events means that session exports nowhere. The cause is almost always
  that it started before the telemetry config or the collector existed — the exporter binds
  at process start and never retries. The fix is to restart it; nothing recovers the gap.
- **Rising counters prove transport, not usefulness.** An idle session re-sends
  `claude_code_session_count_total` forever, so the pipeline looks busy while carrying
  nothing. Never conclude "healthy" from volume alone.
- **Compaction.** `trigger=manual` with a `precompute_reuse` miss is money left on the table;
  the reason string names the mechanism and changes between releases, so quote it rather than
  paraphrasing.
- **Hook failures** are `num_non_blocking_error != 0`. A non-zero `num_blocking` is a deny
  rule doing its job — not an error.
- **MCP `disconnected`** on an `sdk-cli` entrypoint is subagent teardown. Only treat it as a
  fault when the entrypoint is `cli` or an error field is present.

## Traps that have burned this before

- A `hostPort` never appears in `ss -ltn` — it is an iptables DNAT. Test with
  `/dev/tcp/127.0.0.1/<port>`, not a listener list.
- `otelq ready` failing on a machine does **not** mean telemetry is down. Ingest and query
  fail independently; the collector can be accepting on 4317 while every query port is shut.
- **A pod-readiness check cannot see a broken query path.** `telemetry-health.sh` reads
  Deployment readiness through kubectl and a ClusterIP, so it is node-agnostic by
  construction and stayed green through the whole 2026-08-23 outage. Green there is not
  evidence that `otelq` works; run `otelq ready` yourself.
- **A command whose whole output is one JSON line defeats a line filter.** `probe.py targets`
  is one such line, so `| grep -vi up` dropped the entire payload and the empty output read
  as "every target is up" while a target was down. Filter with `jq`, not `grep`.
- An idle `--bg` job holds no resident process. `ps` shows only `bg-spare` workers. Liveness
  lives in `~/.claude/jobs/<short>/state.json` and a live `rv/<short>.sock`.
- A restarted session reports under a **new** `session_id`. A query pinned to the old id
  reads as dead while the session exports normally.
- k3s embeds containerd. `command -v docker podman` finding nothing does not mean a machine
  runs no containers.

## Analyse the data

The health gate is clear when every machine is reachable, `otelq ready` succeeds, `--deep`
lists no silent session, and every node's `os_version` holds a non-zero share. Then run every
step below. The window is `7d`. Re-run a step at `24h` only when its 7d figure looks off, to
tell a standing pattern from a recent change.

Every query here was checked against live data on 2026-10-09. The event and field names still
change between releases, so a step that returns nothing gets the enumerate query from
*Writing the query* before it is reported as zero.

1. **Savings headlines.** The tooling rules have their own analyser; start there.

   ```bash
   otelq savings all --rows
   otelq savings failures --rows        # the retry tax
   otelq savings bytes --rows           # where context goes
   otelq savings subst --rows           # is the substitution rule holding
   otelq savings prompts --since 24h --rows
   otelq savings subagents --rows
   ```

   `reduction` and `trend` read local files, so run them on each machine being measured
   rather than over ssh (see *Writing the query*).

2. **Spend and cache efficiency.** Cost is a Prometheus counter, labelled by `model`. Tokens
   carry `type` = `input`, `output`, `cacheRead`, `cacheCreation`.

   ```
   sum by (model) (increase(claude_code_cost_usage_USD_total[7d]))
   sum by (type)  (increase(claude_code_token_usage_tokens_total[7d]))
   ```

   Report the cache-read share, `cacheRead / (cacheRead + cacheCreation + input)`. A falling
   share means sessions are re-paying for their prefix. Name the model that dominates spend.

3. **API errors.** Count `api_error`, `api_retries_exhausted` and `internal_error` against
   `api_request` in the event enumeration. Report the rate, not the count. For a non-zero
   count, pull the events with `--stream --limit 5` and quote the error field.

4. **Tool failures.** `tool_result` carries `success` and `tool_name`:

   ```
   sum by (tool_name) (count_over_time({service_name="claude-code"} | event_name="tool_result" | success="false" [7d]))
   ```

   Compare each tool's failures against its total. A tool failing at several times the
   overall rate is the finding. A raw count only says which tool is used most.

5. **Hook failures.** Group by `hook_event`, then pull an example of the worst one:

   ```
   sum by (hook_event) (count_over_time({service_name="claude-code"} | event_name="hook_execution_complete" | num_non_blocking_error!="0" [7d]))
   ```

   The event says how many hooks failed, never which. Name the hook event, and then read the
   hooks registered for it to find the candidate.

6. **MCP churn.** Group `mcp_server_connection` by `status` and `app_entrypoint`. Apply the
   `sdk-cli` rule from *Reading the result* before reporting. A `failed` status is always
   worth a line.

7. **Compaction.** Group `compaction` by `trigger`, and apply the `precompute_reuse` rule
   from *Reading the result*.

Rank the analysis findings by what they cost: dollars first, then interruptions, then context
bytes. A step with nothing unusual gets one line saying so, with its number. It does not get
its own section.

## Report

Lead with the machine that has a problem, or say plainly that all three are healthy. For each
finding give the evidence field it came from and the exact command that fixes it — this skill
does not mutate anything, so the user runs the fix.

When the gate cleared, the analysis follows the health line in the same report. Each
analysis finding carries its number, what it is compared against, and the change that would
move it, such as a hook to fix or a rule to tighten.

Done when every machine is either accounted for as healthy or carries a named finding with a
command attached, and any machine the sweep could not reach is called out as unknown rather
than silently dropped. When the gate cleared, every step in *Analyse the data* also has
either a finding or a one-line all-clear.
