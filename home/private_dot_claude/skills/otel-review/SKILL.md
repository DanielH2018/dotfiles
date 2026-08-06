---
name: otel-review
description: Use when reviewing, auditing or debugging Claude Code OTEL telemetry across the machines — this PC, daniel-box, daniel-server. Covers pipeline health, sessions that export nowhere, api_error rates, hook failures, MCP connection churn, and compaction cost. Triggers on "review the OTEL logs", "check telemetry", "is anything not exporting", "why is Loki empty".
---

# otel-review

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

Start with `--rows`. Escalate to `--deep` when the fast pass shows a machine with events
but you are asked whether anything is missing — silent sessions are invisible to the fast
pass by construction.

## The three machines are not alike

| | backends | reached by |
|---|---|---|
| this PC | docker compose | 127.0.0.1 |
| daniel-box | k3s, `observability` ns | 127.0.0.1 via hostPort |
| daniel-server | docker | container bridge IP — Loki is **not** published on the host |

`daniel-server` has no Tempo. `tempo: unreachable` there is the correct answer, not a finding.

For anything deeper on daniel-box, the authority is
`~/server/ansible/roles/k8s/claude-otel/CLAUDE.md` **on that host** — read it rather than
restating it here, so the two cannot drift.

## Reading the result

Judge each machine against what it should look like, then report only what departs.

- **Zero events is not automatically a fault.** A machine with no sessions since the window
  opened is idle, not broken. Confirm before calling it: compare against transcript mtimes
  under `~/.claude/projects`. `--deep` does this for you.
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
- An idle `--bg` job holds no resident process. `ps` shows only `bg-spare` workers. Liveness
  lives in `~/.claude/jobs/<short>/state.json` and a live `rv/<short>.sock`.
- A restarted session reports under a **new** `session_id`. A query pinned to the old id
  reads as dead while the session exports normally.
- k3s embeds containerd. `command -v docker podman` finding nothing does not mean a machine
  runs no containers.

## Report

Lead with the machine that has a problem, or say plainly that all three are healthy. For each
finding give the evidence field it came from and the exact command that fixes it — this skill
does not mutate anything, so the user runs the fix.

Done when every machine is either accounted for as healthy or carries a named finding with a
command attached, and any machine the sweep could not reach is called out as unknown rather
than silently dropped.
