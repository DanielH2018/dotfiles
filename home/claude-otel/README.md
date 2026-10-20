# claude-otel — local observability for Claude Code

Self-hosted, single-user OpenTelemetry stack for Claude Code. Everything runs in
Docker, binds to `127.0.0.1` only, and keeps all data on this machine. Content logging is
**on**: prompts, responses, and tool arguments/output are stored verbatim. That is a
deliberate choice for a single-user local stack, and the reason nothing here listens off
the loopback interface — treat the Loki and Tempo volumes as being as sensitive as the
transcripts themselves.

```
                                                 ┌─ /metrics:8889 ◄─scrape─ Prometheus ─┐
Claude Code ──OTLP/gRPC:4317──► otel-collector ──┼─ OTLP ─► Loki ───────────────────────┤► Grafana :3000
   (host)                                        └─ OTLP ─► Tempo ──────────────────────┘
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

Content is enabled by `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
`OTEL_LOG_TOOL_DETAILS` (arguments and output on events) and `OTEL_LOG_TOOL_CONTENT`
(full input/output on spans — requires tracing). Without them prompts and responses read
`<REDACTED>` and tool arguments are absent, though tool *names* are reported either way.
`OTEL_LOG_RAW_API_BODIES` is deliberately left off: it captures the same content by
storing every request and response body whole, re-serialising the system prompt and the
entire conversation history on each call.

## Start / stop

On **fedora** the container engine is rootless podman, not Docker, and `podman-docker`
provides `/usr/bin/docker` as a shim. Compose is not bundled with either: `podman compose`
delegates to an external provider it expects to find at
`~/.docker/cli-plugins/docker-compose`. Install the upstream compose v2 binary there
(`chmod +x`, no sudo, no daemon) and both `podman compose` and the `docker` shim work.
podman-compose is the wrong choice here — it mishandles the
`depends_on: service_completed_successfully` that `tempo-init` relies on.

On the **work Mac** (`MacBook-Pro-2`) the engine is Docker Desktop, and a launchd agent
starts the stack, so nothing has to be typed after a reboot. The agent
`com.daniel.claude-otel` runs `~/claude-otel/ensure-up.sh` at load and again whenever
`~/.docker/run/docker.sock` changes. The script waits up to two minutes for `docker info`
to answer, then runs `docker compose up -d`. chezmoi deploys the script on darwin only.
The plist is not deployed: it lives in the repo's `scheduled/` directory like every other
launchd job, and its header carries the activate, deactivate and reload commands.

- After editing `ensure-up.sh`, run `chezmoi apply ~/claude-otel`, then restart the job
  with `launchctl kickstart -k gui/$(id -u)/com.daniel.claude-otel`. A running launchd
  job keeps executing the script version it started with, and launchd does not rerun it
  on its own until the socket changes.
- After editing the plist, kickstart is not enough. launchd read the plist at bootstrap,
  so bootout, re-render and bootstrap it as the plist header shows.
- To check the agent, run `launchctl print gui/$(id -u)/com.daniel.claude-otel` and read
  `~/claude-otel/launchd.log`, which takes the script's output and `docker info`'s stderr.

The agent was down from 2026-08-04 to 2026-10-20. launchd's PATH has no `docker`, so
every run logged `command not found: docker`, and the agent sat renamed to `.disabled`.
The script now exports a PATH that includes Docker Desktop's bundled CLI.

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
`home/.chezmoitemplates/settings.base.json`, gated as
`{{ if ne .chezmoi.hostname "daniel-pi" }}` — **on everywhere except daniel-pi**. It is
written as an exclusion so a newly onboarded machine reports from day one instead of
waiting for someone to remember to add it; being outside the gate is silent by design, no
telemetry and no error.

Every host exports to `localhost:4317` and every host keeps its own data — nothing leaves
the box that produced it. What differs is **who is listening on 4317**, which is a property
of the machine, not of this repo:

| Host | Collector on `:4317` | Runs this stack? |
|---|---|---|
| `fedora`, `daniel-wsl` | its own `claude-otel` | **yes** — `docker compose up -d` |
| `MacBook-Pro-2` (work Mac) | its own `claude-otel`, but see the org override below | **yes** — the launchd agent starts it |
| `daniel-desktop` | `daniel-wsl`'s, via WSL2 localhost forwarding | no |
| `daniel-server`, `daniel-box` | the one their existing observability stack already runs | **no — see below** |
| `daniel-pi` | — | no, and no exporter env either |

**Servers must not bring this stack up.** A server already runs its own Grafana/Loki/
Prometheus, and its collector already holds `127.0.0.1:4317` — on `daniel-server` that is
the one port of this stack's seven already bound, so a second collector would collide on
exactly the port Claude Code exports to. `.chezmoiignore` keeps the compose files off
those hosts for that reason. Claude Code there plugs into the existing collector by
pointing at the same address it always does.

That collector still has to *route* what it now receives — Claude Code's metrics, logs and
spans have to reach that stack's Prometheus/Loki/Tempo. That is the server's own collector
config, not this repo's, and it is the thing to check first if a server reports nothing.

**Per workstation:** `chezmoi apply` → `cd ~/claude-otel && docker compose up -d`.
Until something is listening, Claude Code retries OTLP exports to `localhost:4317` in the
background (harmless connection-refused noise, no user-visible impact).

**Env changes only apply to _new_ Claude Code sessions** — restart Claude Code after the
stack is up, then metrics/logs start flowing within ~10s. A session that predates the
change carries no `OTEL_*` at all, which looks identical to a broken stack.

### The org override on the work Mac

On the work Mac, Claude Code sessions export to Lithic's shared collector, not to this
stack. The measured symptom on 2026-10-20: Claude Desktop sessions carry
`CLAUDE_CODE_ENABLE_TELEMETRY=1`, their metrics reach Lithic's Grafana Cloud, and the
local collector had accepted no records hours after the stack came back up. Desktop
sessions are about 96% of spend on this machine.

What a 2026-10-20 check found:

- The org pushes server-managed settings to `~/.claude/remote-settings.json`. Its `env`
  sets `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRICS_EXPORTER`
  and `OTEL_METRICS_INCLUDE_SESSION_ID`. Managed settings outrank the user `env` block
  key by key, so the endpoint is the org's. Keys the org does not set still come from
  `settings.base.json`; the darwin note there records `session_id` reaching the org's
  Prometheus that way.
- That file is not specific to the desktop app. It sits in `~/.claude`, so it applies
  to every Claude Code session on this machine, CLI included. So the expectation that
  the local stack still receives CLI sessions is unverified, and probably wrong: no CLI
  session was run against the revived stack to test it.
- The desktop app does not ignore the user `env` block. A Desktop session's Bash shell
  has every non-`OTEL_*` key from it, such as `CLAUDE_CODE_SUBAGENT_MODEL` and `EDITOR`,
  and `CLAUDE_CODE_ENABLE_TELEMETRY=1`. It has none of the `OTEL_*` keys, from either
  file. The shell's environment is what Claude Code hands its tools, so this does not
  show which `OTEL_*` values the app process itself exports with.
- `/Library/Application Support/ClaudeCode/managed-settings.json` does not exist on this
  machine, so the remote settings are the only managed tier.

To make this stack receive the Mac's telemetry, the org override has to go, and the
content-logging gate in `settings.base.json` has to be revisited with it. Changing this
repo alone cannot redirect a key the org sets.

To repeat the check, list key names only. `OTEL_EXPORTER_OTLP_HEADERS` can hold a token:

```bash
jq -r '.env | keys[]' ~/.claude/remote-settings.json
```

### Telling the hosts apart

Once more than one machine reports, no query is complete without saying which host it is
about. Discriminate on the resource attributes rather than guessing:

| | `fedora` | `daniel-wsl` | `daniel-desktop` |
|---|---|---|---|
| `os_type` | `linux` | `linux` | `windows` |
| `os_version` | `7.1.5-201.fc44.x86_64` | `…-microsoft-standard-WSL2` | `10.0.26200` |
| `wsl_version` | absent | `2` | absent |
| `terminal_type` | `xterm-ghostty` | `wsl-Ubuntu` | `xterm-256color` |
| `user_id` | one hash | another | another again |

Two traps that follow from this. `daniel-desktop` writes no transcript under
`~/.claude/projects` — its sessions live in `/mnt/c/Users/daniel/.claude/projects/`; a hook
that looks "broken 10×" has before turned out to be 100% Windows and 0% WSL. And each
workstation's stack holds only its own data, so `localhost:3100` means a different Loki
depending on where you are sitting.

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

## Diagnosing a hole in the data

Work down this list — it is ordered by how often each has actually been the answer, and
the first two both produce *silent* multi-day gaps.

1. **Does the session even carry the env?** Env changes only reach new sessions, and a host
   outside the gate gets no telemetry and no error. `env | grep OTEL_` in the session that
   looks unreported; nothing at all there is the answer, not a symptom.
2. **Is dockerd actually up, or merely socket-activated?** `docker.service` must be
   *enabled*, not just `docker.socket`. With only the socket enabled, dockerd waits for a
   human to run a `docker` command, so after each reboot the stack stays dark until someone
   touches it — this produced a three-day hole (07-26 to 07-28) with zero `claude_code_*`
   series. `sudo systemctl enable docker.service`, and on WSL `/etc/wsl.conf` needs
   `systemd=true`.
3. **Was a bind-mounted config edited without a restart?** See the note below — `up -d`
   alone does not reload one.
4. **On a server, is its collector routing Claude Code's signals anywhere?** It will accept
   the OTLP and quietly drop it if no pipeline exports it.

Two things that are *not* the answer, both of which have cost time:

- **Retention never is,** at these windows: Prometheus 90d, Loki 31d, Tempo 30d.
- **Events older than a container's `StartedAt` do not prove the stack was up then.** The
  OTLP exporter buffers and flushes on reconnect, so events timestamped well before a
  collector started will legitimately land on it.

Note also that the collector loses its Prometheus *exposition* state across a restart:
`curl -s localhost:8889/metrics | grep -c claude_code` returning 0 right after a restart
means no session has exported since — the historical samples are still in Prometheus.

Since PR #181 the collector's own health is scraped as well (`otelcol_exporter_send_failed_*`,
queue depth, on `:8888`), so a batch dropped en route to Loki or Tempo is a series you can
query rather than a hole you notice days later.

## If Claude Code later runs inside a container

If you start running Claude Code in a container on the `workspace_default` docker network
(per the SessionStart hook in `settings.json`, which renders only where the
`is-container` chezmoi template holds), attach this stack's collector to that
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
