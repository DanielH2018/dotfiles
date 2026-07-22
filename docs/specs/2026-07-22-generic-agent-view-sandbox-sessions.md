# Generic (terminal-agnostic) Agent View for claude-sandbox sessions — spec

**Date:** 2026-07-22
**Status:** Spec / ready to implement (Phase 1 first, verify, then Phase 2)
**Goal:** See, attach/switch, and (bonus) start `claude-sandbox` coding sessions from one picker — working under **both** the current terminal setup (WezTerm) **and** Ghostty, via a **generic pattern that does not depend on WezTerm**. Switching must feel instant (see Performance).

**Naming (de-branded):** the generic layer carries **no terminal brand** in its names. `wezterm` survives only as one *backend id* and in genuinely WezTerm-specific config. Renames: `wezview` → `agentview`; `wezterm-state.sh` → `agent-view-state.sh`; `~/.claude/wez-state/` → `~/.claude/agent-view/`.
**Isolation decision (locked):** skip-permissions coding stays inside the Docker `claude-sandbox`. This is the vendor-prescribed boundary for `--dangerously-skip-permissions` (Anthropic: *"Always run `--dangerously-skip-permissions` sessions inside a container, a VM, or the sandbox runtime"* — `code.claude.com/docs/en/sandbox-environments.md`). No isolation regression is introduced.

---

## 0. Why this shape (decision record)

The original wish — run coding sessions *in* the Docker sandbox **and** manage them from Claude Code's native **Agent View** — is not achievable on Claude Code 2.1.217:

- Native Agent View only surfaces workers the **host supervisor forks itself** (verified: host daemon roster shows only host-forked workers; `claude-sandbox` has zero daemon interaction and runs its own in-container supervisor). Confirmed still true at 2.1.217 — `claude agents --help` exposes no adopt/remote/custom-worker-command flag. See `2026-07-21-claude-sandbox-fleetview-bridge-design.md` §0.
- The built-in **OS sandbox is not a substitute** for the container in bypass mode: it only sandboxes Bash; **Read/Edit/Write, MCP servers, and hooks run unconstrained on the host** (`code.claude.com/docs/en/sandbox-environments.md`). The host already sets `permissions.disableBypassPermissionsMode: "disable"`, i.e. bypass mode is deliberately off on the host.

So Docker stays; native Agent View is out. The real need is **"a reliable way to see/attach/switch among running sandbox sessions,"** which does not require Claude internals at all — a `claude-sandbox` session is a foreground `docker run -it ... claude --dangerously-skip-permissions` (`claude-sandbox:2240,2243`) running **in a host terminal pane**. Switching to it = focusing that pane. An existing picker (`wezview`, renamed to `agentview` here) already does exactly this for host sessions but (a) is WezTerm-specific and (b) never sees sandbox sessions.

The disproven fragile path — a TCP relay reverse-engineering Claude's PTY/control sockets — is explicitly **not** pursued (version-coupled, security regression).

---

## 1. The generic pattern

Three layers; only one is terminal-specific and it is isolated behind a two-function interface.

### 1a. Session registry (terminal-agnostic)
A directory of one JSON file per live session. Generalizes the current state schema (today `~/.claude/wez-state/<sid>.json` → `{pane,state,cwd,session,host,ts}`, written by the soon-to-be-renamed state hook).

Registry: `~/.claude/agent-view/<key>.json`
```json
{
  "key":     "<file key: host session_id, or claude-sandbox INSTANCE_ID>",
  "run":     "<this launch's unique id (claude-sandbox RUN_ID); guards the delete>",
  "kind":    "sandbox | host",
  "cwd":     "<host-side working dir (repo/worktree path)>",
  "title":   "<display label, e.g. 'airflow · claude/foo (sandbox)'>",
  "state":   "working | needs-input | completed | idle",
  "host":    "<hostname>",
  "ts":      1690000000,
  "backend": "tmux | wezterm | none",
  "locator": "<backend-tagged, opaque focus target>"
}
```
`locator` is the only backend-specific field and is never interpreted by the core — only by the matching backend's `activate`.

**Key + delete-guard (resolves the collision race).** For sandbox rows the file key is `INSTANCE_ID`, which is deterministic per repo/worktree (`claude-sandbox:263-271`) — safe here because sessions **always run per branch/worktree** (one live session per target; a repeat launch on the same target auto-resumes rather than duplicating). To stay robust regardless, the entry also stamps `run = RUN_ID` (the launch-unique id, `claude-sandbox:272`), and **cleanup deletes the file only if its `run` still matches this launch** — so if a newer session ever reused the same key, the older session's exit can't delete the newer one's row. Writes are atomic (temp + `mv`); the host state hook keeps keying on the Claude `session_id` as today (`wezterm-state.sh:11`).

Reuse + de-brand decision: **rename the store to `~/.claude/agent-view/`** and keep the same write path/logic (don't fork a parallel system) — the current host-session registration and homelab-sync move to the neutral name in the same change. Local migration is trivial (state files are ephemeral, deleted on session end — no back-fill; repoint writer + reader, stale `wez-state/` files age out). **Cross-machine caveat:** the homelab pull reads the remote's registry dir (`wezview:203-204`), so the renamed **writers must be deployed on every machine with or before the reader** — otherwise remote rows vanish until the remote is updated. This is an ordered `chezmoi apply` across hosts, not a pure age-out. Added fields (`kind`, `backend`, `locator`) are backward-compatible (absent → `kind:host`, `backend:wezterm`, legacy cwd correlation).

### 1b. Picker (terminal-agnostic)
The `fzf` picker, grouping, preview card, and homelab-snapshot sync in the current tool are already generic. Rename `wezview` → `agentview` and add a backend layer: render rows from the registry (unchanged), and on `<enter>` call the **backend dispatch** instead of the hardcoded `wezterm cli` path (`wezview:85-94`, `305-375`). File citations reference the current (pre-rename) implementation.

### 1c. Backend interface (the only terminal-specific code)
Two shell functions, selected once per invocation by environment detection:

| fn | when | contract |
|---|---|---|
| `av_capture_locator` | at session start (registration) | echo a `backend:locator` string identifying the current pane |
| `av_activate_locator <locator>` | on picker select | focus that pane; no-op-safe if stale |

The `locator` stores the **concrete, resolved pane id captured at session start** — not a cwd/title to correlate later. This is the key performance lever: activation becomes a single direct command with no discovery step (see Performance).

**Backend detection precedence** (first match wins):
1. **tmux** — `$TMUX` set. Portable across *any* outer terminal incl. Ghostty and WezTerm.
   - capture (robust): `tmux:<socket>:%N` — `%N = tmux display -p '#{pane_id}'` (server-stable, survives window/pane reorder) **plus** the server socket `tmux display -p '#{socket_path}'` (also the first `:`-delimited field of `$TMUX`), so the id is unambiguous when multiple tmux servers/sockets are in play.
   - activate: `tmux -S <socket> select-pane -t %N \; select-window` (+ `switch-client` if detached). One IPC round-trip, no list.
2. **wezterm** — `$WEZTERM_PANE` set, no tmux.
   - capture: `wezterm:$WEZTERM_PANE` — the pane id directly from the env, no `list` call.
   - activate: `wezterm cli --prefer-mux activate-pane --pane-id <id>` (`wezview:90`). Direct; the current cwd-correlation is kept only as a legacy fallback for pre-rename entries.
3. **none** — neither present (e.g. bare Ghostty window, no mux).
   - capture: `none:` + cwd only.
   - activate: cannot programmatically focus; picker shows the resume command (`claude-sandbox -b <branch> <repo>`) and cwd for manual switch. **Logged as a known limitation** — no silent no-op.

**Ghostty guidance (documented, not enforced):** Ghostty ships no scriptable pane-addressing CLI (config uses `shell-integration = zsh`; no mux CLI). To get attach/switch under Ghostty, **run sessions inside tmux** — then backend #1 handles it. Without tmux, Ghostty degrades to backend #3 (list + manual). This is the crux of "generic, not WezTerm-bound": tmux is the portable substrate; WezTerm-mux is a supported optimization for the current setup.

**tmux focus limitation (documented).** `select-pane`/`select-window`/`switch-client` reposition focus *within* a tmux server/client — tmux has **no** window-manager control and cannot raise the OS window hosting a given client. So tmux-backend switching is reliable when all sessions live in **one tmux server attached to one visible terminal window**; the split cases (picker outside tmux with the target inside another window's tmux, or multiple detached clients) can focus the right pane but not raise the right window. Full window-raising parity exists only under the WezTerm mux (which can raise its GUI pane). This is an accepted limitation, not a bug — the common single-window-tmux workflow is unaffected.

### 1d. Remote machines (multi-machine) — list-only for now, attach deferred
The backend abstraction is designed to run **on every machine** — each host registers its sessions into its own `~/.claude/agent-view/` with **its** backend/locator, and the picker pulls remote registries as a **cached background snapshot** (never on the open path — see Performance), rendering remote rows tagged with their `host`. **In this iteration remote rows are list-only: they display but do not attach.** Reason (verified): the existing tool correlates remote panes by cwd precisely because a stored pane id "is only valid in the mux where it was recorded … can't be trusted across the local vs. homelab windows" (`wezview:8-9,26-28`) — so direct cross-machine activation is *not* the trivial "one IPC" the local case is, and cross-terminal window-raising has real gaps. Remote **attach** is therefore explicitly **deferred** (see §7).

What Phase 1 must do for remote: keep the renamed homelab-sync working (list + resume command shown, no programmatic focus), and leave the schema/backend seam clean so a future iteration can add per-host delegated activation (e.g. `ssh <host> agentview --jump <key>`) without a redesign. Local attach (this machine's sessions) is fully supported now.

---

## 2. Phase 1 — registration + generic switch (ship, then verify)

**Deliverable:** every running `claude-sandbox` session appears in the picker on every machine, correctly labeled, and `<enter>` focuses its pane (via whichever backend is active); the entry disappears when the container exits.

1. **`claude-sandbox` launcher writes a registry entry.** In the host launcher (runs in the user's pane, so `$WEZTERM_PANE`/`$TMUX` are in-scope), just before the final interactive `docker run` (`claude-sandbox:2243`):
   - compute `key = INSTANCE_ID`, `run = RUN_ID` (`claude-sandbox:263-272`), `cwd = host repo/worktree path`, `title` from repo + branch, `backend/locator = av_capture_locator`, `kind = sandbox`, `state = working`.
   - write `~/.claude/agent-view/$INSTANCE_ID.json` atomically (temp + `mv`).
   - **Register on the interactive path only.** The headless `--exec` branch (`claude-sandbox:2226-2235`, used by `sandbox-dispatch`) has no pane to focus and must **not** register.
   - **Cleanup goes inside the existing `cleanup()`** (`claude-sandbox:2179`), which is already installed via `trap cleanup EXIT` (`:2201`). Do **not** add a second `EXIT` trap — Bash keeps only one, so a new trap would silently clobber `cleanup()` and leak the socket-proxy container, network, worktree, and the temp gh-token file (a secret). Add a guarded removal to `cleanup()`: delete `~/.claude/agent-view/$INSTANCE_ID.json` **only if** its `run` matches this launch's `RUN_ID` (§1a delete-guard).
   - Extract the write/guarded-remove into a shared helper (`agent-view-register.sh`) so the renamed `agent-view-state.sh` hook and the launcher share the write path (reuse, don't re-implement) — see M-note below on the two write shapes.
2. **Rename + generalize the picker** (`wezview` → `agentview`, backend-aware): add `av_capture_locator`/`av_activate_locator` with the three backends; replace the hardcoded activate (`wezview:85-94`) with `av_activate_locator`. Legacy entries (no `backend`) fall back to the current cwd-correlation so nothing regresses.
3. **Label sandbox rows** distinctly in the render (a `sandbox` tag / color) so they're visually separable from host sessions.

**Shared-helper scope (writer divergence — don't over-promise reuse).** The helper centralizes the *atomic write* and *guarded delete*, but the callers genuinely differ and it must accommodate all three: the launcher writes a full record keyed by `INSTANCE_ID`; the renamed host `agent-view-state.sh` keys by Claude `session_id` and must **add** the new `kind/backend/locator/title` fields it doesn't emit today (current schema is only `{pane,state,cwd,session,host,ts}` — `wezterm-state.sh:11`+); the Phase-2 container hook does a partial state-only update (§3). Model it as `write_full` + `update_state` + `guarded_remove`, not one monolithic write.

**Why the launcher-captured `locator` sidesteps correlation entirely:** because the launcher runs in the target pane, it records that pane's own id directly — so activation never needs to match by cwd/title (which would matter if we tried to *discover* the pane later). This both removes a failure mode (container title propagation through `docker run -t` is irrelevant) and removes the per-jump `list` call. Empirical check in Phase 1: launch a throwaway sandbox session, confirm `select-pane -t <captured-%N>` / `activate-pane --pane-id <captured>` focuses it directly with no discovery step.

**Phase 1 verification (gate before Phase 2):**
- Start two `claude-sandbox` sessions in different repos/worktrees (under tmux, and separately under WezTerm-mux).
- Open the picker: both appear, labeled `sandbox`, with correct repo/branch and `host`.
- `<enter>` on each focuses the correct live pane in each backend.
- Exit one session → its row disappears within one refresh.
- Existing host-session rows and homelab sync still work (no regression).

---

## 3. Phase 2 — live state from inside the container (after Phase 1 verified)

Phase 1 shows a static `working`. Phase 2 surfaces real transitions (`working → needs-input → completed → idle`) driven by Claude's own hooks **inside** the container.

**Mechanism (single file, two writers, joined by `INSTANCE_ID`):**
- Bind-mount the host registry dir **read-write, narrow** into the container: `-v "$HOME/.claude/agent-view:/home/claudebot/.claude/agent-view"` (only session-state JSON; no secrets — acceptable under the isolation decision). Nesting under the existing `$STATE_DIR:/home/claudebot/.claude` mount (`claude-sandbox:1761`) is fine — it's the established pattern (`projects`, `plugins`, `commands`/`agents` all nest the same way). *Caveat:* on macOS Docker Desktop the uid mapping lets `claudebot` write host binds regardless of owner; on native-Linux Docker this would hit a uid-mismatch `EACCES` — note it if this ever runs off Desktop.
- Pass the key into the container as an env var: `-e AGENT_VIEW_KEY=$INSTANCE_ID`.
- **New hook events must be added** — the sandbox's container config today wires only PreToolUse/PostToolUse-style hooks (`settings.base.json`), with **no** `UserPromptSubmit`/`Notification`/`Stop`/`SessionEnd`. Phase 2 adds those handlers and bind-mounts the new hook script into `.claude-defaults/hooks/` so `entrypoint.sh` copies it into the live `~/.claude/hooks/`. Event→state mapping: `UserPromptSubmit`→`working`, `Notification`(permission/idle)→`needs-input`, `Stop`→`completed`.
- The in-container hook does an **update-if-exists-only** read-modify-write of `~/.claude/agent-view/$AGENT_VIEW_KEY.json`, changing **only** `state` + `ts`; launcher-owned `run/pane/locator/backend/cwd/title` are preserved.
- **Resurrection guard (M3).** The container hook **never creates** the file — if it's absent (launcher already deleted it on exit), the update is a no-op. This prevents the container from re-creating a row the launcher's cleanup just removed (which would otherwise orphan a dead row until the 7-day prune). The launcher's `cleanup()` remains the sole creator/deleter.

This keeps ownership clean: **launcher owns identity/locator/lifecycle; container only mutates `state` of an already-live row.** No cross-namespace pane knowledge is needed in the container.

**Phase 2 verification:**
- A sandbox session mid-task shows `working`; when it hits a permission/confirmation prompt the row flips to `needs-input`; on turn completion → `completed`.
- Concurrent sessions update independently (no file clobbering — atomic temp+mv).
- Kill the container: the row is removed by `cleanup()` even if the last container-written state was `working`, **and** a hook event firing during teardown does not re-create the row (update-if-exists-only guard).

---

## 4. Performance & responsiveness (hard requirement)

Open, close, and switch must feel instant. Targets and the design choices that hit them:

| Operation | Target | How it's kept fast |
|---|---|---|
| **Open picker** | perceived-instant (<~150ms to first paint) | Render from the cached local registry files **only** — no network, no `docker ps`, no subprocess-per-row. Preserve the current tool's tactics: pure-bash cwd normalizer + **one** `jq` for the whole render (`wezview:62-84`), not per-row. Homelab rows come from a cached snapshot; the live remote refresh runs in the background and swaps in via `fzf --listen` without blocking the open (`wezview:339-362`). |
| **Switch (↵)** | effectively instant | `locator` holds the concrete pane id → activation is **one** IPC call (`tmux select-pane -t %N` / `wezterm cli activate-pane --pane-id`), **no `list`/correlate step**. The detached 0.25s re-activate (`wezview:91`) stays only to beat the picker-close refocus race; it's non-blocking and does not delay the perceived switch. |
| **Close / cancel** | instant | `esc` exits fzf directly; the background refresh job is killed by the `EXIT` trap so nothing lingers holding the PTY (`wezview:353`). |
| **Register (session start)** | negligible, off-path | One atomic small-JSON write (temp + `mv`); not on any interactive path. |
| **State update (Phase 2)** | negligible, event-driven | Fires on Claude hook events only (never polled). Tiny read-modify-write over the bind mount; Docker Desktop virtiofs makes a few-hundred-byte write sub-millisecond in practice; atomic temp+`mv` prevents torn reads. |

**Freshness without polling cost.** The picker globs the registry dir once per open — O(active sessions) small files (dozens at most), trivial to stat+parse. No fs-watch daemon, no polling loop. Manual `⌃r` refresh + the existing background live-reload cover the rest.

**Anti-goals (explicitly forbidden on the hot path):** per-render `docker ps`; synchronous `ssh` on open; per-row `jq`/subprocess fan-out; an fs-watch/polling loop. Any of these reintroduces the lag the design avoids.

**Measurement.** Reuse the tool's existing `prof` timing mechanism (defined `wezview:144`, invoked from `:306`) behind an env flag so open-render time stays observable and regressions are caught. Phase 1 verification adds a wall-clock check: open + switch each under the target on a warm cache.

---

## 5. Bonus — start new sessions from the picker

Add an `fzf` action / keybinding (sibling to the existing `CTRL+SHIFT+S` spawn in `wezterm.lua.tmpl`, and a tmux keybinding in `~/.tmux.conf` for the tmux backend) that prompts for repo + worktree/branch and spawns `claude-sandbox <repo> -w|-b …` in a **new pane** in the active backend (tmux `split-window`/`new-window`; wezterm `cli spawn`). Reuses `claude-sandbox`'s existing repo/worktree/branch completion (`--complete-worktrees`/`--complete-branches`). Lower priority than Phases 1–2.

---

## 6. Files touched (all in chezmoi source `~/.local/share/chezmoi`)

| File | Change |
|---|---|
| `home/private_dot_claude/sandbox/executable_claude-sandbox` | write/remove registry entry around `docker run`; Phase 2 mount + env |
| `home/private_dot_claude/hooks/executable_agent-view-register.sh` | **new** shared register/remove helper (used by launcher + state hook) |
| `executable_wezterm-state.sh` → `executable_agent-view-state.sh` | **rename** + call the shared helper; add `kind/backend/locator`; write to `agent-view/` |
| `home/dot_local/bin/executable_wezview` → `executable_agentview` | **rename** to backend-aware `agentview`; add tmux/none backends; direct-locator activate; label sandbox rows |
| `home/private_dot_claude/sandbox/settings.base.json` (or the sandbox hook set) | Phase 2 in-container state hook |
| `home/dot_config/wezterm/wezterm.lua.tmpl` (call `agentview`), `home/dot_tmux.conf` | keybindings: open picker; bonus spawn — per backend |

Grep for lingering `wez`/`wezview`/`wez-state` references across the config on completion (settings hook wiring, keybindings, homelab sync) and update them to the neutral names; keep `wezterm` only where it's genuinely WezTerm-specific (the `wezterm` backend, `wezterm.lua.tmpl`).

Commit in `~/.local/share/chezmoi`; `chezmoi apply` deploys. No changes to the airflow repo.

---

## 7. Out of scope
- Native Claude Agent View / FleetView integration (proven infeasible — §0).
- TCP-relay PTY bridge (rejected — fragile, security regression).
- Replacing Docker with the built-in OS sandbox for skip-perms (rejected — §0).
- Non-tmux Ghostty programmatic focus (degrades to list + manual; documented).
- **Remote/cross-machine attach** — deferred. Remote rows are **list-only** this iteration (see §1d); the schema + backend seam are left clean so per-host delegated activation (`ssh <host> agentview --jump`) can be added later without redesign. Local attach is fully in scope now.
- Concurrent duplicate sessions on the *identical* repo+worktree/branch — unsupported by assumption (sessions are always per branch/worktree; a repeat launch auto-resumes). The `run`-stamped delete-guard (§1a) keeps even this case from corrupting the registry.

## 8. Resolved decisions
1. **Rename to neutral names** — `~/.claude/agent-view/`, `agentview`, `agent-view-state.sh`. State files are ephemeral (deleted on session end), so no back-fill migration; repoint writers + reader and let stale `wez-state/` files age out.
2. **tmux locator = robust** — store `#{socket_path}` + `#{pane_id}` (`%N`), so the id is unambiguous across multiple tmux servers/sockets and survives window/pane reorder. Activate via `tmux -S <socket> select-pane -t %N` (§1c).
3. **Remote backends — list-only now, attach deferred.** The backend layer is designed to run on every machine, but this iteration keeps remote rows **list-only** (display + resume command, no programmatic focus) because cross-mux pane ids aren't directly addressable (`wezview:8-9,26-28`) and cross-terminal window-raising has gaps. The seam is left clean to add per-host delegated activation later (§1d, §7). Remote registry pull stays a cached background snapshot, never on the open path (Performance).

## 9. Review outcomes folded in (2026-07-22)
Pre-implementation review (verified against source) surfaced and resolved:
- **Trap clobber (critical):** registry cleanup goes **inside** the existing `cleanup()` (`claude-sandbox:2179/2201`), never a second `EXIT` trap — else it leaks the proxy/network/worktree/temp gh-token. (§2)
- **Key collision (critical):** `INSTANCE_ID` isn't launch-unique; added `run = RUN_ID` stamp + guarded delete, plus the always-per-worktree assumption. (§1a, §7)
- **Remote pane claim (critical):** the earlier "directly addressable, no delegation" claim contradicted `wezview:8-9,26-28`; remote attach deferred to list-only. (§1d, §7)
- **tmux window-raise limit (moderate):** documented — tmux focuses within a visible client but can't raise an OS window; full parity only when sessions share one visible tmux server. (§1c note below)
- **Rename cross-machine ordering (moderate):** deploy renamed writers on every machine with/before the reader; the "age-out" story covers only the local path.
- **Phase 2 resurrection race + new hook events + writer divergence (moderate):** update-if-exists-only guard; add `UserPromptSubmit/Notification/Stop` handlers + mount the hook; `write_full`/`update_state`/`guarded_remove` helper shape. (§2, §3)
- **Stale citations fixed:** `docker run` `:2243`; EXIT trap `wezview:353`; `prof` `wezview:144`.
