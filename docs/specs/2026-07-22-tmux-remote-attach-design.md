# tmux-based remote attach for Agent View — spec

**Date:** 2026-07-22
**Status:** Spec / ready to implement (verify homelab prerequisites first)
**Goal:** Pressing `<enter>` on a **remote** (homelab) session in the `agentview` picker
attaches to it — not just lists it. Achieved by moving the homelab (and any Unix
remote) **off WezTerm-mux onto tmux** as the multiplexer, so attach is a portable
`ssh -t host tmux attach` rather than a WezTerm-mux-only operation.

This is the deferred "remote attach" from
[`2026-07-22-generic-agent-view-sandbox-sessions.md`](2026-07-22-generic-agent-view-sandbox-sessions.md) §7,
now unblocked by the substrate decision below.

---

## 0. Decisions (locked via brainstorming)

1. **tmux runs on Unix hosts only.** The homelab (and any Linux/Mac remote) run tmux;
   Claude sessions live in tmux panes there. Local **Windows WezTerm stays native**
   (sessions in WezTerm panes, `backend=wezterm`). The WezTerm-mux `ssh_domain` for the
   homelab is **retired** in favor of `ssh -t host tmux`.
2. **Fresh local tab per attach.** On `<enter>` for a remote row, the local picker
   spawns a **new WezTerm tab** running `ssh -t host tmux attach …` landed on the target
   pane. Always works, no local↔remote attachment state to track, and WezTerm naturally
   focuses the new tab — sidestepping the "tmux can't raise the OS window" gap.
3. **One tmux session per Claude session** on the homelab, named from repo/cwd. Every
   local tab is then an independent client landing exactly on its target session (clients
   on *different* sessions don't fight over the active window; clients on the *same*
   session would). A thin homelab launcher makes this turnkey.

Non-goals unchanged from the parent spec: no TCP/PTY relay, no native Agent View
integration, no OS-window raising beyond spawning a fresh focused tab.

---

## 1. Homelab substrate (prerequisite half)

For a homelab session to appear **and** be attachable it must run inside a named tmux
session and register into `~/.claude/agent-view/`.

### 1a. Launcher — one named tmux session per Claude
A thin homelab command (working name `ct`, shipped as `~/.local/bin/ct` or a shell
function) launches Claude inside a fresh named session:
```sh
ct [dir]            # name = basename of $dir|$PWD, sanitized; dir defaults to $PWD
  → tmux new-session -A -s "$name" -c "$dir" 'claude'
```
`new-session -A` attaches if the named session already exists (resume) rather than
duplicating — matching the sandbox "auto-resume per target" assumption. Manual
`tmux new -s foo; claude` remains valid; the hook captures whatever session it lands in,
so the launcher is convenience, not a hard dependency.

### 1b. Register homelab sessions (wire the state hook on Linux)
`settings.base.json` currently gates the Agent View state hooks `{{ if eq .chezmoi.os
"windows" }}`. Extend the gate to **Windows + Linux** so the homelab writes
`~/.claude/agent-view/<session_id>.json` on every hook event, exactly as Windows does
today. (macOS is left out for now — it runs `claude-sandbox`, which already registers
via the launcher; add later if bare-host Mac sessions are wanted.)

### 1c. Extend the tmux locator with the session name
`av_capture_locator` (in `agent-view-register.sh`) currently emits
`tmux:<socket>:<pane_id>`. Add the session name so a fresh-tab attach has its `-t`
target without a second lookup:
```
tmux:<socket>:<session>:<pane_id>
```
captured via `tmux display -p '#{socket_path}\t#{session_name}\t#{pane_id}'`. Session
names are validated (the launcher sanitizes) so the `:`-split stays unambiguous; socket
paths carry no `:`.

### 1d. Ordered redeploy + tmux presence
The renamed/updated writers (`agent-view-state.sh`, `agent-view-register.sh`) and the new
Linux hook gating must be **deployed on the homelab (`chezmoi apply`) with or before** the
local picker relies on them — otherwise remote rows show stale/legacy locators. tmux must
be installed on the homelab (Brew-only in `tools.toml` today; ensure it on the Linux
installer / confirm present).

---

## 2. Remote attach in the picker (local Windows)

`do_jump` (in `agentview`) splits on host:

- **Local row** (`host == selfhost`) → unchanged: in-process `av_activate_locator`
  (wezterm/tmux/none), or legacy cwd-correlation fallback.
- **Remote row** (`host != selfhost`) with a `tmux:` locator → **spawn a fresh local
  WezTerm tab** attached at the pane:
  ```
  wezterm cli spawn -- ssh -t "<sshalias>" \
    "tmux attach -t '<session>' \; select-pane -t '<pane>'"
  ```
  - `<sshalias>` maps from the row's `host`; default the known `daniel-server` (the same
    alias `refresh_remote` already uses). A tiny hostname→alias map, extensible per host.
  - The spawned tab is what the user sees; any failure (host unreachable, session gone)
    surfaces **in that tab** as the ssh/tmux error — never a silent no-op.
  - **Degradation:** a legacy 3-field `tmux:<socket>:<pane>` locator (no session) →
    attach to the most-recent session and `select-pane` best-effort, or show the manual
    `ssh -t host tmux attach` hint. A `none:`/absent locator remote row stays list-only
    with a resume hint (unchanged).

Remote rows are therefore **no longer list-only**. Local attach and sandbox rows are
unaffected.

---

## 3. Retire WezTerm-mux

In `wezterm.lua.tmpl`:
- **Remove** the `server_nodes` → `ssh_domains` block and `multiplexing = "WezTerm"`.
- **Rewire CTRL+SHIFT+H** from "spawn a daniel-server mux tab" to a general homelab entry:
  `ssh -t daniel-server tmux new-session -A -s main` in a fresh local tab.
- The default-domain-stays-local rationale block becomes moot (no remote mux domain) —
  trim it.
- **CTRL+W:** the hang it works around was the mux round-trip over WireGuard. With no mux
  domain, closing a pane is local and can't hang. Verify, then simplify the smart-close
  callback — but **keep the ESC-dismiss for the picker** (a clean fzf exit is still nicer
  than force-closing the fzf pane). The `agentview` OSC uservar stamp stays.

---

## 4. Files touched (chezmoi source `~/.local/share/chezmoi`, root `home/`)

| File | Change |
|---|---|
| `home/private_dot_claude/hooks/executable_agent-view-register.sh` | `av_capture_locator` tmux form → add session name |
| `home/dot_local/bin/executable_agentview` | `do_jump`: local vs remote split; remote-tmux spawns `wezterm cli spawn … ssh … tmux attach`; hostname→ssh-alias map; legacy-locator degradation |
| `home/.chezmoitemplates/settings.base.json` | state-hook gate `windows` → `windows + linux` |
| `home/dot_local/bin/executable_ct` | **new** thin homelab launcher (named tmux session per Claude) |
| `home/dot_config/wezterm/wezterm.lua.tmpl` | remove `ssh_domains`/mux; rewire CTRL+SHIFT+H to ssh+tmux; trim mux rationale; (maybe) simplify CTRL+W |
| `home/.chezmoidata/tools.toml` or Linux installer | ensure tmux on the homelab |
| `tests/agent-view-register.test.js` | tmux locator now includes session |
| `tests/agentview.test.js` | remote-tmux attach spawns the ssh command; local unchanged; legacy-locator degradation |
| `tests/ct.test.js` | **new** launcher names + `new-session -A` behavior (stub tmux) |

`.chezmoiignore`: `ct` and `agent-view-state.sh` are Unix-side — confirm gating so `ct`
deploys on Unix (not Windows). Commit in the chezmoi source; ordered `chezmoi apply`
(homelab first, then local).

---

## 5. Data flow (end to end)

1. Homelab: `ct ~/airflow` → tmux session `airflow` → `claude` → state hook fires →
   writes `~/.claude/agent-view/<sid>.json` with `host=daniel-server`, `kind=host`,
   `locator=tmux:/tmp/tmux-1000/default:airflow:%3`.
2. Local picker: `refresh_remote` ssh-pulls the homelab registry → cache → renders the
   remote row (host badge = homelab).
3. `<enter>` → `do_jump` sees `host != selfhost` + `tmux:` locator →
   `wezterm cli spawn -- ssh -t daniel-server "tmux attach -t 'airflow' \; select-pane -t '%3'"`
   → new local WezTerm tab, focused, attached at the pane.

---

## 6. Testing / verification

- **Unit (hermetic, node:test):** locator-with-session capture; remote-tmux `do_jump`
  spawns the exact `ssh … tmux attach … select-pane` via a `wezterm`/`ssh` stub; local
  `do_jump` still activates in-process; legacy-locator degradation; `ct` names + resumes.
- **Live gate:**
  1. On the homelab, `ct <repo>` starts Claude in a named tmux session; the row appears
     in the local picker labeled homelab, correct repo, within one refresh.
  2. `<enter>` opens a new local WezTerm tab attached to that session at the pane.
  3. A second remote session attaches into its **own** tab without yanking the first.
  4. Killing the homelab session makes its row disappear and a stale attach shows the
     tmux error in-tab (not a silent no-op).
  5. Local rows + sandbox rows still attach as before; CTRL+W no longer hangs.

---

## 7. Out of scope
- Local Windows tmux (WezTerm stays native).
- Multi-remote beyond the single `daniel-server` alias (the hostname→alias map is left
  extensible, but only one entry ships).
- Reuse-existing-tab attach (chose fresh-tab; no attachment-state tracking).
- Starting *new* remote sessions from the picker (the parent spec's §5 bonus).
- macOS bare-host session registration (sandbox already registers; add the Mac gate later
  if wanted).

## 8. Assumptions to confirm at implementation (homelab probe declined)
- The homelab is chezmoi-managed and picks up these hooks on `chezmoi apply`.
- tmux is present (or installable) on the homelab.
Either being false is a small addition, not a redesign.
