# claude-otel — local observability for Claude Code

Self-hosted, single-user OpenTelemetry stack for Claude Code. Everything runs in
Docker, binds to `127.0.0.1` only, and keeps all data on this machine. **No prompt,
response, or tool content is collected** — only metrics and structured event logs.

```
Claude Code ──OTLP/gRPC:4317──► otel-collector ──┬─ /metrics:8889 ◄─scrape─ Prometheus ─┐
 (WSL host)                                       └─ OTLP ─► Loki ──────────────────────┤► Grafana :3000
```

## What's collected

- **Metrics** (Prometheus): sessions, token usage (by model/type), estimated cost,
  lines of code, commits, PRs, active time, code-edit accept/reject decisions.
- **Event logs** (Loki): tool decisions, `api_request` / `api_error` / `api_refusal`,
  `mcp_server_connection`, plugin lifecycle, permission-mode changes. Metadata only.

Content-logging env vars (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
`OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`) are deliberately **unset** → default off.

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
`home/.chezmoitemplates/settings.base.json`, so it deploys to **every machine** through the
generated `~/.claude/settings.json` (`chezmoi apply` after cloning). All telemetry data
stays local on each machine — nothing leaves the box.

**Per machine:** clone dotfiles → `chezmoi apply` → `cd ~/claude-otel && docker compose up -d`.
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
- `OTEL_METRICS_INCLUDE_SESSION_ID=false` keeps Prometheus cardinality bounded over time.
- Retention: Prometheus 90d, Loki 31d (edit in `docker-compose.yml` / `loki-config.yaml`).
