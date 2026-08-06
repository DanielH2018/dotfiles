# Agent View — remote freshness, multi-host, and list density — design

**Status:** design approved (2026-08-05); pending spec review before planning.

## 0. Decisions (locked via brainstorming)

| Decision | Choice | Why |
| --- | --- | --- |
| Overall direction | Fix the diagnosed defects; keep the fzf picker shape | The shape is not the problem — execution is. Re-skinning to match `claude agents` chases a UI Anthropic changes without warning. |
| Remote freshness mechanism | ssh connection multiplexing (`ControlMaster`/`ControlPersist`) | Measured 0.53s → 0.08s. One mechanism fixes both the jump stall and the refresh cost. |
| Failure visibility | In scope, against the initial selection | The current no-error path makes "unreachable" indistinguishable from "no sessions". See §3. |
| Completed/idle rows | Collapse to a fold line, expandable | Keeps finished sessions resumable while shortening the default list. |
| Multi-host | `daniel-server` + `daniel-box`, the latter displayed as **Box** | Added mid-interview. Forces the per-host cache split in §2. |

## 1. Problem

Agent View is being avoided in favour of the built-in `claude agents`, for two stated reasons: **jump latency** and **untrusted data**. The interview localised both.

The render path is not the cause. Measured on daniel's Fedora box, 2026-08-05:

```
agentview --body      0.03 s   (3 runs, identical)
claude agents --json  0.26 s   (3 runs: 0.26 / 0.26 / 0.29)
```

Agent View renders roughly **10× faster** than the tool being preferred over it. The architecture already opens on a cached snapshot and live-reloads via fzf's `--listen` (`agentview:400-412`). The defects are elsewhere:

1. **Remote jumps pay a full ssh handshake.** `focus.sh:111` is a bare `exec ssh -t "$sshalias" "$rcmd"` with no multiplexing. Confirmed absent: `ssh -O check daniel-server` returns `No ControlPath specified for "-O" command`.
2. **Remote failure is invisible.** The refresh path is documented as having no error path (`agentview:405-410`): "If curl/ssh are missing or the pull fails, the picker just keeps showing the cached snapshot — no error path." On the box as inspected, `~/.agentview-remote-cache` **does not exist at all**, so homelab rows render as nothing and nothing says why.
3. **The tail is noise.** 7 files in `~/.claude/agent-view/` against 3 live sessions in `~/.claude/sessions/`, oldest dating to 2026-08-01.

Scope note: local rows' state and Windows-row accuracy were explicitly *not* raised as problems, and are out of scope.

## 2. Measurements

All taken 2026-08-05 on the Fedora 44 box.

| Operation | Cold | Warm (multiplexed) |
| --- | --- | --- |
| `ssh daniel-server true` | 0.53 / 0.55 / 0.59 s | 0.09 / 0.08 / 0.08 s |
| `ssh daniel-box true` | 0.39 / 0.18 / 0.18 s | not separately measured |

Warm figures were obtained with an explicit `-o ControlMaster=auto -o ControlPath=… -o ControlPersist=120` master, then closed with `ssh -O exit`. The saving is ~450ms per remote operation against daniel-server.

**What multiplexing does not fix:** the Windows daemon roster costs ~0.7s because it is a Windows *process spawn* (`"$WIN_CLAUDE" agents --json`, `common.sh:44-56`), not an ssh round-trip. It stays memoised and off the render path exactly as it is today. Any claim that this work speeds up Windows rows would be false.

## 3. Design

### 3.1 ssh multiplexing

Agent View constructs its own ssh option set rather than depending on `~/.ssh/config`:

- Behaviour travels with the tool, so the picker does not silently degrade if the ssh config changes.
- It avoids altering global ssh behaviour for unrelated work.
- It survives a `chezmoi apply` that rewrites a templated ssh config.

Applies to both remote call sites: the interactive attach (`focus.sh:111`) and the refresh fetch.

Constraints:

- **Fail fast, never hang.** A stale or dead master socket must not block the picker. The existing `ConnectTimeout` bound is retained and must also cover the multiplexed path.
- **`ControlPath` directory must exist** before first use, or ssh silently declines to multiplex.
- Socket naming must be per-user/host/port (`%r@%h:%p`) so two hosts do not collide.

### 3.2 Multi-host and display aliases

`HOST_SSH` (`agentview:150`) is currently a single hardcoded entry:

```bash
declare -A HOST_SSH=( [daniel-server]="daniel-server" )
```

It gains a `daniel-box` entry. The display-name map is **not new** — `HOST_LABEL` already exists at `agentview:148` (`[daniel-server]="Homelab"`), and `host_label()` at `agentview:168` falls back to `${1#daniel-}`, which would render `daniel-box` as lowercase `box` if left alone. Getting **Box** is therefore a two-line change across the two existing `declare -A` tables, not new machinery.

The real work in this slice is the cache split below.

**The cache must split per host.** Today a single flat `~/.agentview-remote-cache` holds all remote rows. With two hosts that is a correctness bug, not a style choice: one unreachable host blanks the other's rows on the next write. Each host gets its own cache file.

Consequences:

- The refresh fans out to both hosts **concurrently**, so wall-clock stays roughly one handshake rather than the sum of two.
- `Ctrl+X` on a remote row currently filters "the ssh cache" (`actions.sh:86`); it must resolve to the correct host's file.
- The local glob that reads per-session state must continue to ignore these files — the current design deliberately keeps the cache out of the state dir and without a `.json` suffix for this reason (`agentview:78-82`). Per-host naming must preserve that property.

### 3.3 Unreachable and staleness signal

**In scope against the initial selection.** The evidence is that the box is in the failure state right now: the cache file is absent, remote rows are missing, and the UI is silent. Connection multiplexing does not address this — a warm master that cannot connect degrades identically.

There is also a **second silent-failure path the interview did not surface**, found while reading `refresh_remote` (`rows.sh:331-397`). The ssh call is `2>/dev/null` and only `rc=255` preserves the old snapshot. A host that connects but whose remote bash fails returns a non-255 code with empty output — which then **overwrites the cache with nothing**. That is the same class of bug as the missing-cache case and must be covered by the same fix, so "succeeded but returned nothing" needs its own outcome value distinct from "genuinely no sessions".

Each host's fetch records an **outcome** and a **timestamp**, in a sidecar file beside the cache (`~/.agentview-remote-status.<host>`) rather than inside it. The cache is JSONL and three consumers run `jq` straight over it (`rows.sh:211`, `render.sh:80`, `actions.sh:154`); a metadata row inside it would break all three.

The render then distinguishes four states per host that it currently cannot:

| State | Outcome value | Renders as |
| --- | --- | --- |
| Fetched, current | `ok` | rows as today |
| Fetched, older than 120s | `ok` | rows, plus `daniel-server · 6m old` |
| Could not connect (rc 255) | `unreachable` | `Box · unreachable`, previous rows retained |
| Connected, remote side failed | `failed` | `Box · fetch failed`, previous rows retained |

The distinction between the last two matters operationally: `unreachable` means the host or network is down, `failed` means the host is up and something on it broke. Both retain the previous snapshot rather than blanking it.

The 120s threshold matches the existing `REAP_GRACE=120` in `rows.sh:25`, so the picker has one staleness constant rather than two competing ones. Below it, rows render exactly as today with no added chrome.

This is a render and cache-format change. No new daemon, no new always-on infrastructure.

### 3.4 Collapse completed and idle

`COMPLETED` and `IDLE` each render as a single fold line, expanding on a keypress. Finished sessions stay resumable — two keys instead of zero — while the default list shows only `PINNED` / `NEEDS INPUT` / `WORKING` / `REVIEW`.

**The one non-render complication.** Group headers and spacers carry an **empty** key, and the `--skip` transform (`agentview:60-76`) exists specifically so the cursor never comes to rest on a keyless row, with `HOPS=4` as the runaway backstop. A foldable header must be *landable* — the exact inverse of the current invariant.

Resolution: fold headers carry a **sentinel key** rather than an empty one. `--skip` then treats them as real rows and passes the cursor through naturally, and the expand action binds to the sentinel. This keeps the existing invariant intact rather than special-casing it — plain headers and spacers stay keyless and stay unlandable.

### 3.5 Repaint while the picker is open

**Added 2026-08-05 after the design was approved**, from the question "how will I get an update from a session if I'm sitting on the agent view screen?" The answer was: you don't.

The reload POST at `agentview:341-346` fires once per `--refresh-remote` — at startup and on `CTRL+F`. There is no timer and no watch, so the list is a snapshot taken when the picker opened. A session that moves to `needs-input` while you are looking at the picker changes nothing on screen. This is part of the same distrust that motivated §3.3, and scoping the original design to remote rows missed it.

The `--listen` port and the `curl` POST already exist. This adds only something to fire them repeatedly:

- **Local changes** arrive as inotify events on `~/.claude/agent-view/`, so a state transition repaints within milliseconds and costs no network.
- **A quiet picker** — no local event within the interval — re-fetches the remote hosts and repaints. `inotifywait -t` returns 2 on timeout, which makes "nothing happened locally" and "go look at the remote hosts" the same branch.
- **Machines without `inotify-tools`** fall back to a plain timer. This is not hypothetical: `inotifywait` is absent on this box today, and these dotfiles deploy to WSL and both servers. A picker that silently stops repainting would be a worse bug than the one being fixed.

The watcher must die with the picker. The existing EXIT trap kills only the refresh job; a surviving watcher would hold the picker's ConPTY open — the failure recorded at `agentview:404-407` as the old `CTRL+W` hang.

## 4. Sequencing

`A → B → C → D`, where D may be pulled forward if an early visible win is wanted.

| # | Slice | Depends on | Exercisable by |
| --- | --- | --- | --- |
| A | ssh multiplexing helper, applied to attach + refresh | — | Jump to a `daniel-server` row; second jump is visibly instant |
| B | Second host, display alias, per-host cache **carrying the outcome field**, concurrent fan-out | A | `Box` rows appear; killing one host leaves the other's rows intact |
| C | Render the outcome — unreachable / failed / stale rows | B | Block ssh to one host; picker says `unreachable` instead of going quiet |
| D | Fold line for `COMPLETED` / `IDLE` | — | Open the picker; tail is two lines; keypress expands |
| E | Repaint while open — inotify on local state, timer for remote | B | Leave the picker open; change a session's state from another terminal; the row moves without a keypress |

**Why the outcome field lands in B rather than C.** B rewrites `refresh_remote`'s write path to produce one cache per host; C's signal is a new field in that same file. Deferring the field to C would mean editing the same write path twice, with a cache format in between that no reader consumes. So B owns the **write** side of the outcome (record it) and C owns the **read** side (render it). C then touches only readers, which is what makes it safe to cut if you change your mind.

## 5. Testing

Existing convention: node tests in `tests/agentview/` (13 suites) driving `tests/lib/agentview-env.js`.

| Slice | Coverage |
| --- | --- |
| A | ssh option-set construction is a pure string-building seam — assert the flags, including that `ConnectTimeout` survives. Fits `agentview-seams.test.js`. |
| B | Per-host cache isolation: write two caches, make one host fail, assert the other's rows still render. Display-alias mapping asserted in the render output. |
| C | Three-state rendering (current / stale / unreachable) from fixture caches — no network needed, since the outcome is recorded in the file. |
| D | Cursor behaviour on fold headers belongs with `agentview-hotkeys.test.js`; the collapsed and expanded renders with `agentview-ui.test.js`. |
| E | A single watch iteration is the seam: stub `inotifywait` to exit 2 (timeout) and assert the remote fetch runs, exit 0 (event) and assert it does not, remove it entirely and assert the timer fallback still fires. No real inotify, no real network. |

Live ssh is not required by any test: every seam is either string construction or a fixture file.

## 6. Explicitly out of scope

- Windows-row accuracy and the ~0.7s roster spawn (not raised as a pain; unaffected by this work).
- Local row state correctness (not raised as a pain).
- Notifications, Stream Deck surfaces, live pane preview, transcript search, worktree/diff actions — all surfaced by the 2026-08-05 competitive scan, none of them the reason the tool is being avoided. Revisit only after the tool stops losing to `claude agents`.
- Re-skinning to match the `claude agents` flow. Deliberately rejected; the shape is not the defect.
