# Plan — `health_sweep` for homelab-mcp (code-mode, option B)

*2026-07-23 · target repo: ansible (daniel-server) · role: `roles/containers/homelab-mcp`*
*Companion artifact: `homelab-mcp-health-sweep_2026-07-23.html`*

## Goal

Add one read-only MCP tool that returns **only the containers needing attention plus counts**,
collapsing a 65-call `container_status` fan-out into a single distilled result. Applies the
"code-mode" idea (Anthropic code-execution-with-MCP, Cloudflare Code Mode, agent-swarm token
measurements) at the source: distill where the data lives, so only the summary crosses into context.

## Grounding insight

`container_status`-per-container is unnecessary. The docker-proxy `/containers/json` payload that
`list_containers` already fetches embeds health in each `Status` string
(`"Up 4 days (healthy)"`, `"Exited (0) 3h ago"`). So the sweep is **one upstream call**, and because
that endpoint omits `Env`, the read-only / no-secrets invariants hold for free.

Measured motivation: one `list_containers` call already returns 65 containers (~6.5 KB / ~1.6k tokens);
a per-container health sweep by hand is 65 raw payloads persisting in context (~100k tokens). The
aggregate tool returns ~200 tokens.

## Changes (follows the repo's own pattern — logic in `safe_reads.py`, wiring in `app.py`)

| File | Change |
|---|---|
| `files/safe_reads.py` | Add pure `classify_container_health(rows)`. Input = `summarize_container_list` output. Returns `{summary: {total, running, unhealthy, exited, restarting, no_healthcheck}, flagged: [rows needing attention]}`. Healthy rows collapse into counts. |
| `files/app.py` | Add `@mcp.tool() def health_sweep() -> dict`: one `_get_json(f"{DOCKER_PROXY}/containers/json", {"all":"1"})` → `summarize_container_list` → `classify_container_health`. ~4 lines, mirrors `list_containers`. |
| `files/test_safe_reads.py` | Unit tests for `classify_container_health` across the status forms below. Offline, no network — matches existing test style. |

## Status-string parsing spec

`state` is authoritative for the running/exited axis; the `(…)` suffix carries health.

| Status | state | Classification |
|---|---|---|
| `Up 4 days (healthy)` | running | healthy — not flagged |
| `Up 13 hours` | running | no healthcheck — not flagged |
| `Up 11 minutes (health: starting)` | running | starting — flag (soft) |
| `Up 2 days (unhealthy)` | running | unhealthy — **FLAG** |
| `Exited (0) 5 hours ago` | exited | not running — **FLAG** |
| `Restarting (1) 3 seconds ago` | restarting | crash-looping — **FLAG** |
| `Created` | created | never started — **FLAG** |

**Fail loud:** any status string that doesn't match a known form is classified flagged/unknown, never
silently healthy — a parser gap must surface a container, not hide one.

### Return shape

```json
{
  "summary": { "total": 65, "running": 64, "unhealthy": 0,
               "exited": 1, "restarting": 0, "no_healthcheck": 6 },
  "flagged": [
    { "name": "scrutiny-collector", "state": "exited",
      "health": "none", "status": "Exited (0) 5 hours ago" }
  ]
}
```

## Test / deploy

```bash
uv run pytest ansible/roles/containers/homelab-mcp/files
```
```bash
uv run ansible-playbook ansible/deploy.yml --tags "homelab-mcp"
```

Verify: call `mcp__homelab__health_sweep` from a client. Image is built — redeploy, not Watchtower.

## Invariants / non-goals

- **read-only** — no write/exec path; reads `/containers/json` only (same endpoint `list_containers` uses).
- **no secrets** — list endpoint omits `Env`; do *not* switch to per-container inspect for richer health.
- **pattern** — decisions in `safe_reads.py` (tested), wiring in `app.py`.
- **scope** — one tool; no log/metric aggregation here.

## Phase 2 (deferred, separate tool)

`logs_triage(minutes=15)` — Loki query for `error|fatal|panic` lines across all jobs, grouped by
service with counts + one sample each, via existing `parse_loki`. More design (LogQL aggregation, noise
filtering) — defer until `health_sweep` proves the pattern.

## Execution blocker (not a plan gap)

The homelab MCP file tools are read-only/jailed and there's no local clone of the ansible repo on the
Windows box. Implementing means editing the repo directly — SSH to `daniel-server`, or clone it locally.
