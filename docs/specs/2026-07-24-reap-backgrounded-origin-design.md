# Reap backgrounded-origin sessions — design

**Date:** 2026-07-24
**Status:** approved (design), pending implementation plan
**Scope:** chezmoi dotfiles repo (`~/.local/share/chezmoi`) — new hook + `settings.base.json` wiring + tests

## Problem

Claude Code's native "background this session" feature forks the current interactive
session into a daemon bg job (launched with `--fork-session --resume <origin>.jsonl
--reply-on-resume`) but **leaves the original interactive process running**. That orphan
serves no purpose — the daemon has taken over the conversation with its own independent
transcript — yet it holds ~430 MB RSS each and shows up in Agentview under its
auto-derived name (e.g. `dev-ce`), confusing the session list.

Today the only cleanup is manual (Agentview `CTRL+X`, or `kill <pid>`). We want it
automatic.

## Goal

The instant a session is backgrounded, terminate its now-redundant interactive origin —
reliably, and without ever touching a session the user still cares about.

## Non-goals

- Reaping idle interactive sessions in general (only backgrounded-origins).
- Deleting transcripts. The origin's conversation stays on disk, fully resumable.
- A general resource governor / memory monitor (separate concern).

## Key facts established during investigation

- Backgrounding is a **native Claude Code** action, not an Agentview one. It spawns a
  daemon bg job; the job's `state.json` carries `"intent": "(backgrounded)"`.
- The **lineage link** (fork → origin) is reliably present in the live daemon's
  `/proc/<pid>/cmdline`: `--fork-session --resume …/<originSessionId>.jsonl
  --reply-on-resume`. The JSONL lineage fields (`parentSessionId`, `forkedFrom`,
  `sourceSessionId`) are all `null`, so they are **not** a usable source.
- The origin PID is recoverable pid-reuse-safely by scanning
  `~/.claude/sessions/<pid>.json` for the one whose `.sessionId == originSessionId`
  (the same technique `av_purge_local` in `executable_agentview` already uses).
- Agentview already prunes dead-pid rows on render (`gather_local_rows`), so a reaped
  origin's row disappears on its own; removing the row file just makes it instant.

## Approach (chosen: A — event-driven hook on the fork)

A new `SessionStart` hook (matcher `startup`) runs **inside the freshly-spawned bg
daemon**. It self-identifies as a backgrounded fork and reaps its own origin. Truly
immediate; no standing process.

**Feasibility verified (2026-07-24):** the existing bg fork `edad6d70`'s transcript
contains `"hookName":"SessionStart:startup"` records — daemon bg jobs *do* fire
`SessionStart`, and with source **`startup`** (not `resume`), and hooks run as bash.
So the matcher is `startup`; the cmdline signature (below) is what makes broad `startup`
matching safe (it no-ops on every normal, non-backgrounded startup).

**Reading the signature:** the hook script is a *child* of the Claude process, so its own
`/proc/self/cmdline` is just `bash …reap….sh`. It must walk up the process ancestry
(`/proc/<ppid>/cmdline`, a few levels) to find the Claude process whose cmdline carries
the fork flags. Injectable via an env seam for tests.

### Fallback (B — periodic sweep)

If verification shows `SessionStart`/`resume` does not fire for daemon bg jobs, fall
back to a small script on a systemd-user timer (or folded into the existing
`wsl-mem-monitor`) that scans live bg-job cmdlines every ~20 s and reaps any still-alive
backgrounded origin. Same detection logic; "immediate" becomes "within one interval."

**Implementation must begin with a canary** confirming the hook fires for a daemon bg
job before building on approach A.

## Detection (strict — this is the safety boundary)

Reap **only** when the ancestor Claude process cmdline (walked up from `$PPID`) contains
**all three** markers:

1. `--fork-session`
2. `--reply-on-resume`
3. `--resume <path>` where `<path>` ends in `.jsonl`

This trio uniquely identifies a *backgrounded* fork. It excludes:

- Plain `--resume` (no `--fork-session`; and origin sid == own sid anyway).
- Interactive (non-background) forks (no `--reply-on-resume`).
- Daemon **respawns** — `respawnFlags` in the job state omit `--fork-session`, so the
  signature won't match on any launch after the first.

## Target resolution & guards

1. `originSid` = basename of the `--resume` path, minus `.jsonl`.
2. Find origin PID: scan `~/.claude/sessions/*.json` for `.sessionId == originSid`, read `.pid`.
3. Guards — reap only if **all** hold:
   - `originSid` != own session id (never self).
   - origin PID resolved and `!= $$` / not in own process ancestry.
   - `kill -0 <pid>` succeeds (origin actually alive).

## Action

- `SIGTERM` the origin PID. **Never `SIGKILL`.** Graceful termination lets Claude flush
  and clean its own `sessions/<pid>.json`; the transcript persists → resumable.
- `rm -f ~/.claude/agent-view/<originSid>.json` so the Agentview row vanishes instantly
  rather than waiting for the next dead-pid prune.
- Append one audit line to `~/.local/state/reap-origin.log`:
  `<iso-ts> reaped origin <originSid> pid=<pid> from fork <ownSid>`.

## Properties

- **Idempotent:** re-fires no-op (signature absent on respawn, or origin already dead).
- **Narrow:** touches only the resolved origin; never the fork or unrelated sessions.
- **Graceful & reversible:** SIGTERM only; conversation stays on disk.
- **Auditable:** every reap logged with origin sid, pid, and initiating fork sid.

## Components

| Unit | Responsibility | Depends on |
|------|----------------|------------|
| `home/private_dot_claude/hooks/executable_reap-backgrounded-origin.sh` | Detect background signature in own cmdline; resolve + guard + SIGTERM origin; log | `~/.claude/sessions/*.json`, `jq`, `/proc/self/cmdline` |
| `home/.chezmoitemplates/settings.base.json` (edit) | Wire hook into `SessionStart` matcher `startup`, short timeout | — |
| `tests/reap-backgrounded-origin.test.js` | Unit tests via env seams | node test harness (existing style) |

## Testing

Mirror the existing Agentview test style (env seam for the kill command like
`AV_KILLCMD`; mock `sessions/` dir; inject a fake cmdline via an env override so the
script doesn't read the real `/proc`). Cases:

- Background signature present + live origin → origin SIGTERM'd once; row file removed;
  audit line written.
- Plain `--resume` (no `--fork-session`) → no-op.
- Interactive fork (no `--reply-on-resume`) → no-op.
- `originSid` == own sid → no-op (never self).
- Origin PID already dead → no-op, no error.
- Origin sid present but no matching `sessions/*.json` → no-op, no error.
- Re-fire with same inputs → still single kill, no double-action.

## Deployment

Edit chezmoi source, then `chezmoi apply` for `~/.claude/settings.json` +
the hook. Deploy to homelab as well (sessions get backgrounded there too), consistent
with how existing Agentview hooks are shipped.

## Resolved risk

`SessionStart` firing for daemon bg jobs is now **verified** (source `startup`, hooks run
as bash — evidence in `edad6d70`'s transcript). Approach B (periodic sweep) is retained as
a documented fallback only if the live end-to-end test reveals the ancestry-cmdline read
is unreliable in practice.
