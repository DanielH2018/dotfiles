---
name: homelab
description: Use when running commands against, inspecting, or debugging the homelab server — connection details, which remote verbs auto-approve without a permission prompt, and when to prefer the homelab MCP tools over raw ssh.
---

# homelab

## Connecting

The server is `ubuntu@10.0.0.161`, aliased as **`homelab`** in `~/.ssh/config`. The remote
user is `ubuntu`, **not** `daniel` — always go through the alias (`ssh homelab '<command>'`)
rather than spelling out a host, so the user is set for you.

## Prefer the MCP tools for read-only questions

The `mcp__homelab__*` tools are deferred — load them with `ToolSearch` before calling. They
return structured data and skip the shell entirely, so reach for them first:

| Question | Tool |
|---|---|
| What's running / how is it | `container_status`, `list_containers`, `top_containers`, `service_health`, `host_overview` |
| Logs | `container_logs`, `query_logs` (Loki) |
| Metrics | `query_metric` (Prometheus), `scrape_targets` |
| Disk, certs, Home Assistant | `disk_health`, `cert_expiry`, `ha_state` |
| Files on the host | `list_files`, `read_file` |

Drop to `ssh` only when no tool covers it.

## Which ssh commands run without a prompt

`ssh` sits in the permission `ask` list, but claude_guard's `readonly_remote_safe()` check
(the claude-guard slice 3 port of `allow-readonly-remote.sh`) auto-approves a narrow
allowlist of provably read-only verbs. Anything outside it still prompts — that is working as
intended, not a failure. Broadly allowed:

- **Host state** — `uptime`, `whoami`, `hostname`, `id`, `date`, `uname`, `df`, `free`, `du`,
  `ps`, `top`, `vmstat`, `iostat`, `lscpu`, `lsblk`, `lsof`, `dmesg`, `sensors`, `nvidia-smi`
- **Files and text** — `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `file`, `tree`, `readlink`,
  `realpath`, `grep`/`rg`, `cut`, `tr`, `jq`, checksums
- **Network** — `ss`, `netstat`, `ping`, `dig`, `host`, `traceroute`; `ip` only with
  `show`/`list`/`get`
- **Services** — `journalctl`, `systemctl status`
- **Docker** — `ps`, `logs`, `images`, `stats`, `version`, `info`, `top`, `port`, `diff`,
  `history`, `events`; plus `ls` under `network`/`volume`/`compose`/`service`/`stack`

Deliberately **not** auto-approved, and each for a reason worth knowing:

- `env` / `printenv` and `docker inspect` / `docker config` — they read as read-only but print
  exported variables and container `Env[]`, which on this host include API tokens. Exfiltration
  path, so they fall through to a prompt.
- `command` — a remote shell builtin that would launder any verb past the allowlist.
- `mount`, `sort -o`, `uniq IN OUT`, `xxd -r IN OUT` — all can write.

The guard also refuses chained (`hl uptime; rm -rf /`) and redirected (`hl cat x > y`)
invocations, and pipes or command substitution. Keep remote calls to one plain verb; do the
piping locally.

For `daniel-server` and `daniel-pi` specifically, a second hook picks up where that one
stops. claude_guard's read-only classifier (its `_ssh` handler, gated on
`TRUSTED_SSH_HOSTS`) re-classifies the remote command, and it parses the whole line — so a local pipeline and connection flags come
along too: `ssh daniel-server docker logs kopia --since 24h 2>&1 | tail -20` and
`ssh -o BatchMode=yes daniel-pi uptime` both go through, and the remote command is held to
the same read-only standard as a local one. Still prompts: forwarding or proxying flags
(`-L`/`-R`/`-D`/`-A`/`-F`, `-o ProxyCommand=…`), a second hop, any other host, and remote
reads of secret paths or globs. Needs `~/server` present; without it the prompt just stands.
