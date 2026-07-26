# claude-otel — local observability for Claude Code

Self-hosted, single-user OpenTelemetry stack for Claude Code. Everything runs in
Docker, binds to `127.0.0.1` only, and keeps all data on this machine. **No prompt,
response, or tool content is collected** — only metrics and structured event logs.

```
                                                 ┌─ /metrics:8889 ◄─scrape─ Prometheus ─┐
Claude Code ──OTLP/gRPC:4317──► otel-collector ──┼─ OTLP ─► Loki ───────────────────────┤► Grafana :3000
 (WSL host)                                      └─ OTLP ─► Tempo ──────────────────────┘
```

## What's collected

- **Metrics** (Prometheus): sessions, token usage (by model/type), estimated cost,
  lines of code, commits, PRs, active time, code-edit accept/reject decisions.
- **Event logs** (Loki): tool decisions, `api_request` / `api_error` / `api_refusal`,
  `mcp_server_connection`, plugin lifecycle, permission-mode changes.
- **Traces** (Tempo): `claude_code.interaction` per turn, with child `llm_request`,
  `tool`, `tool.blocked_on_user` and `tool.execution` spans. This is the only signal that
  attributes a turn's wall-clock — time spent waiting on a permission prompt looks
  identical to time spent running the tool in the metrics and logs.

Traces need **two** env vars, not one: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` turns span
emission on (it is beta-gated), and `OTEL_TRACES_EXPORTER=otlp` routes it. Setting only the
exporter yields silence.

## Start / stop

```bash
cd ~/claude-otel
docker compose up -d          # start
docker compose ps             # check health
docker compose logs -f        # tail
docker compose down           # stop (keeps data volumes)
docker compose down -v        # stop + wipe all stored telemetry
```

Then open **http://localhost:3000** → dashboard **“Claude Code — Usage & Observability”**
(anonymous admin, no login).

## Activating telemetry in Claude Code

The exporter env lives in the chezmoi base template
`home/.chezmoitemplates/settings.base.json`, but it is **gated to this machine**: the whole
OTEL block sits inside `{{ if eq .chezmoi.hostname "daniel-wsl" }}`, so the generated
`~/.claude/settings.json` carries it only here. A freshly onboarded machine gets **no
telemetry and no error** until its hostname is added to that conditional. All telemetry
data stays local on each machine — nothing leaves the box.

**Per machine:** add its hostname to the template gate → `chezmoi apply` →
`cd ~/claude-otel && docker compose up -d`.
Until the stack is running, Claude Code retries OTLP exports to `localhost:4317` in the
background (harmless connection-refused noise, no user-visible impact).

**Env changes only apply to _new_ Claude Code sessions** — restart Claude Code after the
stack is up, then metrics/logs start flowing within ~10s.

## Verifying the pipeline

```bash
# collector is exposing Claude metrics?
curl -s localhost:8889/metrics | grep -c '^claude_code'
# prometheus scraped them?
open http://localhost:9090   # query: {__name__=~"claude_code.*"}
# loki got events?
open http://localhost:3100/ready
# tempo got spans?
curl -s localhost:3200/ready
curl -sG localhost:3200/api/search --data-urlencode 'q={resource.service.name="claude-code"}' \
  --data-urlencode "start=$(date -d '1 hour ago' +%s)" --data-urlencode "end=$(date +%s)"
```

If a dashboard panel is empty, the metric/label name likely has a unit suffix the query's
regex didn't match. Confirm exact names in Grafana **Explore → Prometheus**:
`{__name__=~"claude_code_.*"}`, and in **Explore → Loki**: `{service_name=~".+"}`.

## If Claude Code later runs inside a container

If you start running Claude Code in a container on the `workspace_default` docker network
(per the SessionStart hook in `settings.json`), attach this stack's collector to that
network too and change `OTEL_EXPORTER_OTLP_ENDPOINT` to `http://otel-collector:4317`.

## Notes

- Image tags are pinned; bump them in `docker-compose.yml` as you like.
- `OTEL_METRICS_INCLUDE_SESSION_ID=true` is required for correct totals. With it `false`,
  every concurrent Claude Code process collapses into a single Prometheus series and the
  collector's prometheus exporter (last-writer-wins per label set) stops accumulating:
  raw `sum()` under-reports by ~10x and `increase()[7d]` over-reports by ~274x, because
  each process restart reads as a counter reset. Loki is unaffected — every event log is
  stored independently, so event counts stayed trustworthy throughout.
  The cost is cardinality: one series set per session, held for `metric_expiration` (168h).
- Retention: Prometheus 90d, Loki 31d, Tempo 30d (edit in `docker-compose.yml` /
  `loki-config.yaml` / `tempo-config.yaml`).
- Editing a bind-mounted config (`otel-collector-config.yaml`, `tempo-config.yaml`,
  Grafana provisioning) does **not** take effect on `docker compose up -d` — compose only
  recreates a container when its *service definition* changes. Follow with an explicit
  `docker compose restart <service>`.
