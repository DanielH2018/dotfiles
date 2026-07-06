# Claude Code Sandbox Environment

You are running inside a **Docker container** (Pattern C sandbox), not on the host machine.

## Container facts

- **OS**: Debian stable-slim (Linux), not macOS
- **User**: `claudebot` (UID 1000), non-root
- **No sudo**: `sudo` is denied by permission rules and would fail anyway
- **Security**: `--cap-drop all`, `--security-opt no-new-privileges`
- **Workspace**: The repository is bind-mounted at `/workspace`
- **Audit**: Every tool use is logged by a PostToolUse hook to `/audit/`
- **Artifacts**: `/artifacts` is bind-mounted to a host directory outside the repo/worktree

## Git signing

Commits are GPG-signed via 1Password SSH agent socket at `/run/1password/agent.sock`.
The `SSH_AUTH_SOCK` env var points there. If signing fails, the socket mount may have
permission issues — report this rather than trying to bypass signing.

## GitHub access

- `gh` CLI is installed. Read operations (clone, view PRs/issues, API GET) work when the gh config is mounted.
- Git fetches/pulls from GitHub work automatically — SSH URLs are rewritten to HTTPS and credentials are supplied by `gh auth git-credential` reading from the mounted config.
- **All GitHub write operations are blocked** by deny rules in settings.json (PR create/merge/close, issue create/close, release management, mutating API calls, `gh alias set`, `gh config set`, `gh auth`, SSH, `git remote` mutations, etc.).
- The GitHub token is in the gh config file (`~/.config/gh/hosts.yml`), **not** in environment variables. Do not attempt to read it or pass it to other tools.
- Do not attempt workarounds — the deny rules are intentional.

## Resource limits

The container runs with hard resource caps:
- **Memory**: 8 GB (`--memory 8g`) — processes are OOM-killed beyond this
- **CPU**: 4 cores (`--cpus 4`)
- **PIDs**: 512 (`--pids-limit 512`) — limits fork bombs and excessive threads

If a build or test is killed unexpectedly, check if you hit these limits before debugging further.

## What's different from the host

| Host (macOS) | Container (Linux) |
|---|---|
| Homebrew, fnm, sdkman via shell | Toolchains installed during image build |
| macOS sandbox-exec restrictions | Docker isolation (cap-drop, no-new-privileges) |
| 1Password GUI + SSH agent | 1Password socket only (no GUI) |
| Full filesystem access | Only `/workspace`, `/audit`, `/home/claudebot` |
| Direct Docker socket | Socket proxy (if enabled) — exec/build/system blocked |

## Docker Compose networking

When the sandbox has Docker access (socket proxy), compose services run as sibling containers.
They publish ports to the Docker host's loopback, which is **not** `localhost` from this container's
perspective. To reach compose services from inside the sandbox:

1. After running `docker compose up`, connect this container to the compose network:
   ```bash
   SELF=$(cat /proc/self/cgroup 2>/dev/null | grep -oP 'docker/\K[a-f0-9]+' | head -1 || hostname)
   COMPOSE_NET=$(docker network ls --format '{{.Name}}' | grep '_default$' | head -1)
   docker network connect "$COMPOSE_NET" "$SELF"
   ```
2. Now use compose **service names** (e.g., `postgres`, `kafka`) as hostnames instead of `localhost`.
3. If tests hardcode `localhost`, override connection config to point at the service name.

## Artifacts

Write generated output that isn't meant to go into the git history — reports, exported
files, generated images, ad-hoc scripts you want to keep, etc. — to `/artifacts` instead
of `/workspace`. It's bind-mounted to a host directory (`~/.claude/sandbox/artifacts/<instance>`
on the host, printed at container startup and again on exit) so it's visible without
digging through the worktree or git branch. Files written there don't show up in `git status`.

## Plugins

The host's `~/.claude/plugins/` directory is bind-mounted **read-only** into the container.
Plugin installation must happen on the host. A second read-only mount at the host's absolute
macOS path (`/Users/<user>/.claude/plugins/`) resolves absolute paths in `installed_plugins.json`.

Available plugins: superpowers, code-review, feature-dev, commit-commands, pr-review-toolkit,
claude-md-management, ralph-loop, processing-llm (lpt-pr-curator, lpt-dependabot-reviewer,
lpt-network-specs), and privacy-eng-tools.

## MCP servers

- **context7**: Available (runs via `npx` from the plugin's `.mcp.json`). May take a moment on first use to download the package.
- **Cloud MCPs** (Atlassian, Slack, Notion, Gmail, Google Drive, Google Calendar, PagerDuty, Lithic API Docs, Grafana):
  All write operations are **denied** by settings.json deny rules. Only read/search/list/get operations are permitted.
  On first launch, the launcher runs `claude auth login` in a separate container to establish an
  OAuth session with your Anthropic account. This session is stored in the persistent state volume
  (`~/.claude/sandbox/state/` on the host) and reused on subsequent launches.

  To force re-authentication, delete `~/.claude/sandbox/state/.auth-configured` on the host.

## Dynamic environment

Details specific to this launch are appended below by the entrypoint.
