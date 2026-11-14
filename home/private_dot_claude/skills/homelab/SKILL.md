---
name: homelab
description: Use when running commands against, inspecting, or debugging the homelab — the three hosts and their ssh aliases, how to read cluster state without ssh, and which remote verbs auto-approve without a permission prompt.
---

# homelab

## Connecting

The homelab is a k3s cluster of two nodes plus one Docker host. Each host has an alias in
`~/.ssh/config`, and the remote user on all three is `ubuntu`, **not** `daniel`. Always go
through the alias (`ssh daniel-pi '<command>'`) rather than spelling out an address, so the
alias sets the user.

- `daniel-box` is the k3s server and control-plane node, and runs most workloads.
- `daniel-server`, also aliased `homelab`, is the k3s agent node.
- `daniel-pi` is a Raspberry Pi, and the **only** Docker host.

daniel-box and daniel-server have no Docker, so a `docker` verb sent to either one fails.

## Read cluster state without ssh

To answer a question about workloads, read the cluster directly instead of opening a shell on
a node:

- **`kubectl`** runs as a read-only ServiceAccount, so `get`, `describe` and `logs` work from
  either cluster node. The permission rules deny `kubectl delete`.
- **`scripts/diagnostics/probe.py`** in the server repo is the allow-listed diagnostics tool.
  `probe.py --list` names its checks, and `probe.py health <TAG>` is the post-deploy gate.
- **The `mcp__homelab-ui__*` tools** drive a browser. Use them to check that a UI renders,
  not only that its pod is Ready.

Drop to `ssh` for host state that none of these covers, or for daniel-pi's containers. The
server repo's `CLAUDE.md` is the authority for how a change reaches the cluster.

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
- **Docker, on daniel-pi only** — `ps`, `logs`, `images`, `stats`, `version`, `info`, `top`,
  `port`, `diff`, `history`, `events`; plus `ls` under
  `network`/`volume`/`compose`/`service`/`stack`

Deliberately **not** auto-approved, and each for a reason worth knowing:

- `env` / `printenv` and `docker inspect` / `docker config` — they read as read-only but print
  exported variables and container `Env[]`, which on daniel-pi include API tokens. Exfiltration
  path, so they fall through to a prompt.
- `command` — a remote shell builtin that would launder any verb past the allowlist.
- `mount`, `sort -o`, `uniq IN OUT`, `xxd -r IN OUT` — all can write.

The guard also refuses chained (`hl uptime; rm -rf /`) and redirected (`hl cat x > y`)
invocations, and pipes or command substitution. Keep remote calls to one plain verb; do the
piping locally.

For `daniel-server` and `daniel-pi` specifically, a second hook picks up where that one
stops. claude_guard's read-only classifier (its `_ssh` handler, gated on
`TRUSTED_SSH_HOSTS`) re-classifies the remote command, and it parses the whole line — so a local pipeline and connection flags come
along too: `ssh daniel-pi docker logs alloy --since 24h 2>&1 | tail -20` and
`ssh -o BatchMode=yes daniel-pi uptime` both go through, and the remote command is held to
the same read-only standard as a local one. Still prompts: forwarding or proxying flags
(`-L`/`-R`/`-D`/`-A`/`-F`, `-o ProxyCommand=…`), a second hop, any other host, and remote
reads of secret paths or globs. Needs `~/server` present; without it the prompt just stands.
