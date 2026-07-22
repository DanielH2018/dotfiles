# claude-sandbox → host FleetView bridge — design

**Date:** 2026-07-21
**Status:** Design / not started
**Goal:** See *and* manage/use `claude-sandbox` (Docker) sessions from the host terminal **Agent View (FleetView)** — list, attach, send a prompt, stop — without leaking host credentials beyond an agreed tradeoff.
**Decisions locked:** surface = **host terminal FleetView**; isolation = **narrow bridge** (keep host creds/keys out of the container where possible).

---

## 0. Phase 0 spike results (2026-07-21) — READ FIRST, supersedes the file-mirror plan below

Ran a black-box probe with a throwaway `CLAUDE_CONFIG_DIR` (live daemon untouched). Findings:

| Probe | Result | Implication |
|---|---|---|
| Inject worker into `roster.json` (live + dead pid) | `agents --json` → `[]`; file untouched, no supervisor spawned | **`roster.json` is not the list source.** Hand-editing it does nothing. |
| Inject `jobs/<short>/state.json` (`state:running`) | Appears but coerced to **`failed`** | `jobs/state.json` *is* the read surface — but an entry with no live host-owned worker is marked failed |
| Same, `state:done` | Still **`failed`** | Reconciliation validates worker liveness **and** session lineage, not just pid |
| Live-roster worker `ec813758` excluded from `agents --json` | its pid 28386 is **dead** | R1 confirmed: dead-pid workers are culled |
| Positive control: `agents --json` vs real `~/.claude` | lists the 2 real live sessions correctly | probe is valid |

**Revised verdict.** FleetView surfaces a session as live/manageable only when the **host supervisor owns a live worker it forked** (reachable host-side PTY socket + valid session lineage). A container session satisfies none of this in the host namespaces, and there is **no supported path to register an external process as a host worker**. → The file-mirror approach (§3 Phase 1 below) is **disproven** and will not deliver the goal. Dispatch has no custom-command hook (`claude agents --help` + the `dispatch.launch` block have no command field), so the host supervisor cannot be made to fork a `docker exec` shim either.

### Realistic paths (replaces §3)
1. **TCP-relay + host `claude --resume` (attach, not grid).** Relay serves a host-side Unix socket tunneling over TCP to the container worker's PTY/rv sockets; `claude --resume <sessionId>` on the host attaches to the *live* container session. Delivers "use it from the host terminal," but via resume — **not** an Agent View tile. Still needs RE of the pty/rv handshake + auth (R2/R3), version-pinned. Security gate (§5) applies.
2. **Flip the model (cleanest, blocked today).** Host owns the daemon/PTY; the workload runs in-container via a `docker exec` shim launched as the worker command. Blocked because FleetView dispatch only spawns `claude`. Needs a host `claude` wrapper shim or an upstream "custom worker command" feature.
3. **File upstream.** Correct fix = Anthropic supporting an adopted/remote worker (PTY over a TCP endpoint). Everything else is a workaround.

Everything from §1 onward is retained as the verified architecture record; §3's phased plan is **obsolete** except as history.

---

## 1. How discovery + control actually work (verified on this machine)

FleetView is a filesystem-discovered, socket-controlled model. One **supervisor per (uid, config-dir instance)** owns a control socket and a PTY/rendezvous socket per worker.

**Host side** — FleetView reads `~/.claude/daemon/roster.json`:
- `supervisorPid` 27444, sockets under `/tmp/cc-daemon-501/1db74d77/` (`501` = host uid `daniel`; `1db74d77` = per-config-dir instance hash).
- Layout: `control.sock`, `rv/<short>.sock`, `pty/<short>.sock`, `spare/*.pty.sock`.
- Auth: `~/.claude/daemon/control.key` (32 B) + per-worker `rvAuth`/`ptyAuth` tokens in the roster.
- Jobs: `~/.claude/jobs/<short>/state.json` (`backend: "daemon"`).

**Sandbox side** — the container runs its *own* supervisor, and (crucially) its config dir is bind-mounted to the host:
- `claude-sandbox:1723` → `-v "$STATE_DIR:/home/claudebot/.claude"`, `STATE_DIR=$SANDBOX_DIR/state` (`claude-sandbox:11`) = `~/.claude/sandbox/state`.
- So `~/.claude/sandbox/state/daemon/roster.json` **already exists on the host**: `supervisorPid` 1391, worker sockets under `/tmp/cc-daemon-1000/9f1c84bf/` (`1000` = `claudebot`, inside the container mount ns), `cwd: /workspace`, `cliVersion: 2.1.216`.
- Its own `control.key`, `jobs/`, `dispatch/`, `daemon.status.json`, `daemon.log` are all under `~/.claude/sandbox/state/`.

**The one platform constraint that shapes the design** — Docker Desktop on macOS only reliably bridges Unix sockets in the **host-owned-socket → container-client** direction. The launcher's sole socket forward proves exactly this pattern: `claude-sandbox:1728` (`-v "$OP_SOCKET:/run/1password/agent.sock"`) + `:1762` (`-e SSH_AUTH_SOCK=...`). The reverse (a container-created socket connected to *from* the host) is not supported, and the container's socket paths (`/tmp/cc-daemon-1000/...`, uid 1000) aren't present on the host anyway.

### Consequence
- **Listing metadata is already host-visible** — wrong config dir, not missing. → a *mirror*, not a bridge.
- **Control cannot use socket-over-bind-mount.** FleetView is the *client*; the sockets it touches must be **served by a host process**. → a **TCP relay** whose transport crosses the boundary (TCP works both directions on Docker Desktop; Unix-socket-over-mount does not).

---

## 2. Risks (ranked)

- **R1 — roster liveness culling (make-or-break, unproven).** FleetView very likely validates each worker's `pid` against a live *host* process. A mirrored container entry carries a container pid (e.g. 1420) that is absent/unrelated on the host → the entry may display-then-vanish, or render dead. Everything downstream depends on this. **Spike this first (Phase 0).**
- **R2 — undocumented, version-coupled IPC.** `control.sock` framing, the auth handshake (`control.key` + per-worker `rvAuth`/`ptyAuth`), and the PTY stream/resize/signal control messages are internal and can change between CLI releases. Mitigation: both sides are 2.1.216 today and the launcher builds the image (`claude-sandbox:250` `IMAGE_TAG`), so host/container version parity is enforceable and checkable at bridge start.
- **R3 — auth-token reconciliation.** Host `control.key` ≠ container `control.key`; per-worker tokens differ. The relay must present the *container's* tokens to the container daemon while satisfying FleetView on the host side.
- **R4 — security / isolation regression (see §5).** The sandbox exists to isolate; a control relay punches a bidirectional byte channel back to (or from) the host daemon and the host proxy holds the container's `control.key`.

---

## 3. Staged plan (fail-fast)

### Phase 0 — Spike R1 (~30 min, no build)
Inject one synthetic worker entry into `~/.claude/daemon/roster.json` mirroring a live sandbox worker (copy a `workers.<short>` block from `~/.claude/sandbox/state/daemon/roster.json`), open host FleetView, and observe:
1. Does it display?
2. Does it survive a roster refresh / a few seconds (i.e. is it culled by pid-liveness)?
3. What does an attach attempt do when the socket path is absent?

**Gate:** if entries are culled by dead host pid, Phase 1's mirror must back each entry with a real host process (fold into Phase 2's proxy). If they persist, Phase 1 is a standalone win.

### Phase 1 — Listing mirror (read-only "see them")
A small host background agent (launchd `LaunchAgent`) that watches `~/.claude/sandbox/state/daemon/roster.json` + `jobs/` and mirrors live workers into the host roster/jobs:
- Tag mirrored entries (cwd `/workspace`, a `sandbox:` label / memo) so they're visually distinct.
- Prune entries when the sandbox supervisor drops them or the container exits (`docker ps` filter `claudebot-*`, `claude-sandbox:266`).
- Actions greyed/stubbed until Phase 2.

Deliverable: sandbox sessions appear in host FleetView, correctly labeled, auto-added/removed.

### Phase 2 — Control relay (attach / prompt / stop) — **gated on §5 security review**
`FleetView → host-proxy (Unix socket, host is server) → TCP → container-agent (client to container's real socks) → container supervisor/worker`.
- Host proxy creates `control.sock` + `rv`/`pty` socks on the host at the paths the mirrored roster points to; **backs each mirrored roster pid with the proxy's own pid** so liveness (R1) passes.
- Transport = TCP over loopback via a published port or `host.docker.internal` (the launcher already runs the container on a dedicated network, `claude-sandbox:809,2075` — add a mapped port for the relay only).
- Container agent reconciles auth (R3): presents container `control.key`/worker tokens inbound.
- **Roll out control ops incrementally:** observe/attach (read-mostly) first; enable `prompt` and `stop` only after the attach path is proven and reviewed.
- Pin to image CLI version; refuse to bridge on host/container version mismatch (R2).

---

## 4. Alternatives considered (and why not)

- **Full bind-mount of host `~/.claude` into the container, run as uid 501.** Would make listing+control "just work," but exposes `~/.claude/.credentials.json` + `daemon/control.key` + host worker tokens to the sandbox — directly contradicts the locked "narrow bridge" decision and the sandbox's non-root/egress-proxied/credential-free design. Rejected.
- **Adopt the container session as a host-daemon worker (no container supervisor).** The host supervisor would have to spawn/own a worker whose process+PTY live in the container. No CLI flag or documented mechanism for external/remote workers (`claude --help` shows none). Would also run the process on the host, defeating sandboxing. Not supported.
- **Transcript-only (list + resume from shared session store).** Sessions already land on the host (`claude-sandbox:1727` projects mount + vault `Sessions/` archive). But resume spawns a *host* worker (not the container process) → neither live-attach nor sandboxed. Doesn't meet "manage & use."
- **Socket-over-bind-mount for control.** Blocked by the Docker Desktop direction limitation (§1). This is why the transport is TCP.

---

## 5. Security posture — IN SCOPE (auth / secrets / data access)

The sandbox is a deliberate isolation boundary: non-root `claudebot` (`claude-sandbox:594`), egress via a proxy on a dedicated network, RO mounts, AWS-credential-free by design. A control relay regresses this and must be reviewed before Phase 2 ships:
- The host proxy holds the container's `control.key` and drives a process **inside** the sandbox; the reverse channel lets the container influence a host-served socket. Treat the relay endpoint as a trust boundary: loopback-only, authenticated, single-container-scoped per `RUN_ID`.
- Enable **observe/attach before prompt/stop**; log every control op to the existing sandbox `audit/` trail.
- Document the relay in the work-laptop-config sandbox threat model; do **not** widen the isolation decision without an explicit review.
- Phase 0 + Phase 1 are read-only and low-risk; the security gate applies specifically to Phase 2.

---

## 6. Open questions to resolve during Phase 0/1

1. FleetView roster-liveness semantics (R1) — pid check? heartbeat/`updatedAt` staleness? both?
2. Does FleetView key workers by `short` id globally — will a `9f1c84bf`-instance worker collide with a host `1db74d77`-instance short?
3. Exact `control.sock` handshake + PTY control-message framing (Phase 2 RE; capture with a socket tracer against a throwaway session).
