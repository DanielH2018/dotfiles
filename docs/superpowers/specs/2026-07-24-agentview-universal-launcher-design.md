# Agent View — universal Ctrl+n launcher

**Date:** 2026-07-24
**Component:** `home/dot_local/bin/executable_agentview` (spawn path), with `ct`/`cts`/`ctw` as the canonical launchers.
**Status:** design approved; pending spec review before planning.

## Problem

Ctrl+n in the Agent View picker spawns exactly one kind of session: a raw
`claude-sandbox <repo> [-b branch]` run through `spawn_in_backend`. That means:

- No way to spawn a **plain (native) claude** session in a repo — only sandboxed.
- No way to spawn on the **homelab** — remote sessions must be started by hand with
  `cts --ssh`.
- The bare WSL/WezTerm case runs `claude-sandbox` directly, which registers
  `backend:none` and is **not jumpable** (the exact problem `cts` was built to fix).

We want Ctrl+n to be a universal launcher: pick a **host** (WSL / PC / homelab), a
**repo**, a **branch**, and a **mode** (sandbox vs native, where supported), and spawn the
right session — always jumpable — by delegating to the canonical launchers `ct` / `cts` /
`cts --ssh` (via `ctw`) rather than re-implementing session naming, worktrees, or
placement.

## Capability matrix (what each host supports)

| Host | no-repo | repo source | branch | modes | launcher |
|------|---------|-------------|--------|-------|----------|
| **WSL** | plain claude in `~/dev` | `~/Repositories/*` (glob) | sandbox mode only | **sandbox** (`cts`) / **native** (`ct`) | `cts <repo> [-b br]` · `ct <repo>` |
| **PC** (Windows) | plain claude in `My_Vault` | — (out of scope) | — | native only | `wezterm.exe` git-bash — **unchanged** |
| **homelab** | plain claude in remote `~` | `cts --complete-repos <host>` (ssh, cached) | worktree | native only (no Docker remotely) | `cts --ssh=<alias> [repo] [-b br]` |

Notes:
- **Sandbox exists only locally (WSL).** The homelab is native-only by design — `ct`/`ctw`
  on the remote, no Docker/`claude-sandbox` there.
- **Native local (`ct`) takes a dir only** — no branch/worktree logic — so the WSL native
  mode skips the branch step (main checkout only). The branch step applies to WSL-sandbox
  and homelab (both resolve a worktree).
- PC stays as today: a single "plain claude in `My_Vault`" option, no repo/branch/sandbox.
  Windows repo/sandbox support is explicitly a later slice, not this one.

## Wizard flow (`do_spawn`)

```
Ctrl+n  (or `agentview --spawn`)
 └─ step 0  host>   WSL · PC · homelab        (only registry hosts that are reachable)
     ├─ PC ─────────► spawn_windows_claude       (unchanged; no further steps)
     ├─ WSL
     │   └─ repo>  [no repo · plain claude] · <~/Repositories/*>
     │       ├─ no repo ─► ct ~/dev               (native tmux, jumpable)
     │       └─ repo
     │           └─ mode>  sandbox · native
     │               ├─ native ─► ct <repo>       (no branch step)
     │               └─ sandbox
     │                   └─ branch> (type/pick, empty=main) ─► cts <repo> [-b br]
     └─ homelab
         └─ repo>  [no repo · plain claude] · <cts --complete-repos>
             ├─ no repo ─► cts --ssh=<alias>
             └─ repo
                 └─ branch> (type/pick, empty=main) ─► cts --ssh=<alias> <repo> [-b br]
```

- **Esc / empty at any step cancels the whole spawn and keeps the picker** (today's
  contract; `do_spawn` returns 0/1 without launching).
- On a successful launch, `av_close_picker "$pf"` dismisses the picker popup/tab
  (already wired; unchanged).
- The `@none` ("no repo · plain claude") row is always the first repo-pick row.

## Component design

All pick helpers are pure functions that echo their choice to stdout (independently
testable with stubbed `fzf`/`cts`/`claude-sandbox` on `PATH`). Refactor today's three
spawn helpers into host-parameterized ones:

- **`spawn_pick_host`** → echoes `wsl` | `pc` | `homelab` (empty = cancel). Rows built from
  the source registry (`HOST_LABEL` / `HOST_SSH`), gated by reachability:
  - WSL always present (local).
  - PC only when `is_windows_host "$winhost"` **and** `$WEZTERM_WIN` is executable (today's
    `spawn_pick_repo` guard).
  - homelab only when it has an `HOST_SSH` alias.
  - The host pick is always shown (no auto-select): in practice ≥2 hosts are always
    configured (WSL + homelab), and always-prompt keeps the flow predictable and testable.

- **`spawn_pick_repo <host>`** → echoes repo name, `@none`, or empty (cancel). Repo list
  source switches on host: WSL globs `~/Repositories/*/` (`.git` dir only, skipping linked
  worktrees — today's logic); homelab runs `cts --complete-repos <alias>` (ssh + cached,
  fails fast/quiet). `@none` is always emitted first.

- **`spawn_pick_mode`** → echoes `sandbox` | `native` (WSL-repo only; empty = cancel).

- **`spawn_pick_branch <host> <repo>`** → echoes a branch (empty = main checkout).
  Completion source: WSL uses `claude-sandbox <repo> --complete-branches` (today's);
  homelab uses `cts --complete-branches <alias> <repo>`. `--print-query` so the user can
  type a new branch.

- **`spawn_launch <host> <repo> <mode> <branch>`** → builds `(inner, named, title)` for the
  chosen cell and hands them to the placement helper. Replaces `spawn_build_cmd`.

- **`do_spawn`** becomes the orchestrator wiring host → repo → (mode) → branch → launch,
  with `@windows` short-circuiting to `spawn_windows_claude`.

The homelab ssh alias comes from `HOST_SSH[daniel-server]`, passed as `cts --ssh=<alias>`
so the spawn never depends on `$CTS_REMOTE_HOST`.

## Placement mechanics (the one subtle bit)

**Decision: hybrid placement.** `cts`/`ct` own their own tmux session (`new-session` +
`switch-client`). Calling them from inside fzf's live `execute()` when the picker is itself
a tmux popup would fire `switch-client` out from under a still-alive fzf — a combination not
proven anywhere in the current code. We avoid it entirely: use `cts`/`ct`'s named-session
`exec` **only** in the bare-shell case (where it is the jumpability fix and is proven), and
use the already-proven `tmux new-window` placement when inside tmux.

Each cell therefore yields two command forms:

- **`inner`** — the raw command to run in a fresh pane (already a jumpable tmux pane, so no
  named session needed).
- **`named`** — the named-session launcher to `exec` in a bare shell (creates a jumpable
  named tmux session).

Extend `spawn_in_backend` to take both (`spawn_in_backend <inner> <title> <named>`):

```
if   [ -n "$TMUX" ] && has tmux;         then tmux new-window -n "$title" "$inner"   # proven :640
elif [ -n "$WEZTERM_PANE" ] && has wezterm; then wezterm cli spawn -- bash -lc "$inner"  # :643
else exec bash -lc "$named"              # bare shell → named tmux session, jumpable  :649
fi
```

Per cell:

| Cell | `inner` (new-window / wezterm pane) | `named` (bare-shell exec) |
|------|-------------------------------------|---------------------------|
| WSL @none | `cd ~/dev 2>/dev/null \|\| cd; claude` | `ct "$HOME/dev"` |
| WSL native repo | `cd <repo>; claude` | `ct <repo>` |
| WSL sandbox repo | `claude-sandbox <repo> [-b br]` | `cts <repo> [-b br]` |
| homelab (any) | `cts --ssh=<alias> [repo] [-b br]` | `cts --ssh=<alias> [repo] [-b br]` |
| PC | — (routed to `spawn_windows_claude`) | — |

- Homelab uses the **same** form for both — `cts --ssh` `exec`s `ssh -t`, which is correct
  whether wrapped in `new-window` or `exec`ed in a bare shell (mirrors `remote_attach`
  `:226–243`); the remote `ct` (via `ctw`) creates the named, jumpable session on the host.
- All interpolated paths/branches are `%q`-quoted (today's pattern) so tmux's `sh -c`
  re-parses them intact.

**Consequence:** in the tmux-popup + ctrl-n case, a WSL sandbox/native session lands in a
`new-window` pane rather than a `cts`/`ct` **named** session, so it loses `cts`'s
resume-on-rerun dedup **for that case only** — identical to today's behavior for the sandbox
path. The bare-shell WSL path (the primary one, via the WezTerm tab) gets the full named
session and the jumpability fix.

## Error handling

- **Cancel** (esc / empty) at any step → return without launching, picker stays.
- **Unreachable homelab:** `cts --complete-repos` already fails fast and quiet
  (`BatchMode=yes`, `ConnectTimeout=2`) and falls back to a stale cache; an empty repo list
  still offers `@none` (plain remote claude), and the branch pick's `--print-query` lets the
  user type a repo/branch name regardless.
- **Missing launcher** (`cts`/`ct` not on `PATH`): surface the launcher's own stderr; no new
  pre-flight checks beyond what already exists.
- **PC guard** unchanged: the PC host row only appears when `is_windows_host` and
  `$WEZTERM_WIN` is executable.

## Testing

Extend the existing spawn tests (`agentview-windows.test.js` + spawn coverage), stubbing
`fzf` / `cts` / `claude-sandbox` on `PATH` (the suite already stubs `curl`, `wezterm`,
etc.):

1. **`spawn_pick_host`** — filters to reachable hosts; auto-selects when only one is
   reachable; cancel returns empty.
2. **`spawn_pick_repo <host>`** — WSL uses the `~/Repositories` glob; homelab uses the
   `cts --complete-repos` stub; `@none` is always first.
3. **`spawn_pick_branch <host> <repo>`** — WSL vs homelab completion source; typed query
   passes through.
4. **`spawn_launch` / `spawn_in_backend`** — asserts the exact `(inner, named)` per cell:
   - WSL @none → `ct "$HOME/dev"` (named), `claude` in `~/dev` (inner)
   - WSL native → `ct <repo>` / `cd <repo>; claude`
   - WSL sandbox → `cts <repo> -b <br>` / `claude-sandbox <repo> -b <br>`
   - homelab → `cts --ssh=<alias> <repo> -b <br>` (both forms)
   - Placement branch selection by `$TMUX` / `$WEZTERM_PANE` presence.
5. **Cancel** at each wizard step launches nothing.
6. **Regression:** `@windows` still routes to `spawn_windows_claude`; the existing
   WSL-sandbox-in-tmux behavior is unchanged.

## Out of scope

- Windows (PC) repo / branch / sandbox support — deliberately deferred.
- Any change to the jump/attach path, the source registry hosts, or `ct`/`cts`/`ctw`
  themselves (they already expose everything needed).
