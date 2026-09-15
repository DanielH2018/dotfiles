# pr-dash startup time and collapsible sections

Extends `docs/specs/2026-09-14-pr-dashboard-design.md`, which remains the authority on
everything this document does not change. Read that first: the guard, the token source, the
staleness model and the grouping axes are all defined there and are unchanged here.

## Problem

Launching `pr-dash` takes longer to show rows than it needs to, and the whole startup path is
serial. `main.ts` resolves the token, starts listening, the launcher polls until `/` answers,
`open` launches the browser, and only then does `app.js` request `/api/prs` and trigger the
first GraphQL call. Every step finishes before the network work begins.

Measured by the operator against the shipped tool: the noticeable wait is **after the browser
opens**. The page appears quickly and then sits empty while GitHub is queried. So the cost to
attack is the GraphQL round trip, not the 1Password prompt.

A second problem is unrelated to timing. A dashboard listing every open PR across every
repository is long, and there is no way to fold away a repository or a stack that is not
currently interesting.

## Scope

| Status | Item |
|---|---|
| in | Pre-loading the first fetch so it overlaps browser startup |
| in | In-flight deduplication in the loader |
| in | Persisting the last good payload to disk, restored on the next launch |
| in | Collapsible repository groups and collapsible stacks, with state summaries |
| out | A resident background daemon |
| out | Any change to the guard, the token source, or the GraphQL query |
| out | Actions — merge, close, comment, approve, re-run CI. Still deferred. |

A resident daemon under launchd would remove both the prompt and the fetch from the
interactive path, and it is the largest possible win. It is out of scope because it means a
long-lived process holding a GitHub token for days, and because it breaks the per-launch
secret model: the secret currently lives in memory and dies with the process, which is what
makes a leaked URL worthless afterwards. The measurement does not justify that trade.

## Part 1 — Pre-load the first fetch

`main.ts` calls `loadPrs()` as soon as the token resolves and does **not** await it, then
proceeds to `listen()`. The GraphQL round trip overlaps the launcher's readiness poll and the
browser's cold start, so by the time `app.js` requests `/api/prs` the payload is already in
the cache.

**Not awaiting is load-bearing.** Awaiting before `listen()` delays the port past the
launcher's `curl` probe, which reintroduces exactly the serial wait the pre-load exists to
remove, and can push startup past the launcher's 60-second deadline.

A rejected pre-load must not become an unhandled rejection and must not exit the process. The
loader caches only on success, so a later request retries against GitHub rather than being
served a cached failure.

### In-flight deduplication

`createPrLoader` currently reads the cache, misses, and awaits `fetchAllPrs` with no record
that a fetch is already running. With a pre-load in place, the pre-load and the browser's
request both miss and both fetch — two full paginated queries against the rate limit, racing
to `cache.set`.

The loader tracks the in-flight promise. A miss stores it, concurrent misses return the same
promise, and the entry clears when it settles.

**The entry must clear on rejection as well as on resolution.** A retained rejected promise
would serve that same failure to every later request, turning one transient error into a
permanently broken dashboard.

This closes a finding the previous cycle's whole-branch review parked: "no in-flight dedup, so
two concurrent cache misses both fetch". That finding was tolerable while nothing ran
concurrently. The pre-load makes concurrency the normal case.

## Part 2 — Persist the last good payload

The payload is written to `~/.local/state/pr-dash/last-payload.json` after each successful
fetch, and read at startup so the first `/api/prs` can be answered immediately from disk while
the pre-loaded fetch is still running.

### Where it plugs in, and where it must not

The restore seeds **`withFallback`'s last-good payload, not the cache.** Seeding the
60-second cache would make the pre-load a cache *hit* and skip the fetch entirely, so the
dashboard would show yesterday's rows and never refresh them.

`withFallback` already presents a retained payload as stale, with a banner naming how long ago
the last success was. `fetchedAt` is read from the file, so that sentence stays true across
launches — a payload written three hours ago reads as three hours old. Restored rows therefore
cannot render as fresh, which is the property the parent spec insists on: stale data presented
as fresh is the failure mode to avoid. No new banner state and no new presentation logic are
introduced.

### At rest

The file holds the full payload — repository names, PR titles, branch names, CI and review
state. This is a deliberate decision by the operator, taken over a titles-free skeleton
alternative, because only the full payload paints the real dashboard offline.

- File mode **0600**, directory mode **0700**.
- The mode is set explicitly rather than left to the umask. This machine's login shell runs
  `umask 0007`, which would otherwise produce a group-readable 0640 file.
- `~/.local/state/` is outside chezmoi's managed tree, so the file can never reach the source
  repository. It is not added to `.chezmoiignore` because it was never a candidate for
  deployment.
- The file is overwritten by the next successful fetch. Nothing prunes it otherwise; a PR
  closed on GitHub stays in the file until the next fetch replaces the whole payload.

### Writing and reading

Writes are atomic: write a temporary file in the same directory, then rename over the target.
A crash or a kill mid-write therefore cannot leave truncated JSON that the next launch would
have to reject.

Reads tolerate every way the file can be wrong — absent, empty, truncated, valid JSON of the
wrong shape, or written by an older version with a different schema. Each case discards the
file and starts cold rather than throwing. This is the discipline `parseStoredView` already
applies to `localStorage`, for the same reason: the stored value is whatever was there last,
and a successful parse does not make it the right shape.

A read failure is never fatal. The dashboard's normal cold-start path is the fallback.

## Part 3 — Collapsible repositories and stacks

Repository group headers and stack roots each carry a disclosure toggle. Everything is
expanded by default.

### A collapsed header keeps its signal

A collapsed header shows the number of PRs folded inside **and** a state summary, so folding a
repository away never hides that something inside is failing or waiting on you. Collapsing is
for triage, not only for decluttering.

```
▸ privacy-com/core-server          3 PRs   ●2 failing  ●1 approved
▸ DanielH2018/dotfiles             1 PR    ●1 pending
▾ privacy-com/dbt                  2 PRs
    Add staging model for disputes        success · approved · 2d
    Backfill cashback marts               pending · none · 5d
```

The summary is a pure function over the group's records. It lives in `public/group.js` and is
tested there, because `public/app.js` cannot be imported under `node --test` — `location.hash`
throws at module scope and the project has no jsdom. That constraint is why every guard in
this project gets extracted into a DOM-free module, and the summary is no exception.

### State, and the way back out

Collapse state persists in `localStorage` alongside the existing view state, and **Reset
clears it along with the filters.** The parent spec's reasoning applies unchanged: a saved
state that cannot be cleared is a trap, because the dashboard looks wrong and the reason is
invisible. A collapsed-everything dashboard is exactly that trap.

A collapse-all / expand-all control sits with the other view controls. A way in needs a way
out at the same granularity: per-section toggles alone leave no way to undo a session's worth
of collapsing.

### Keys

Repository groups key on the repository name. Stacks key on the root PR's `id`, which is
already `owner/name#123` and already unique.

A key naming a repository or stack that no longer appears — a PR merged, a repository with
nothing open — is simply unused. Unknown keys are ignored rather than treated as corruption,
because the stored state legitimately outlives the payload it described. This follows from the
same validation discipline as Part 2: tolerate what is there, use what makes sense.

Filters and collapse do not interact. A group whose every member is filtered out does not
render at all, which is existing behaviour, so its collapse key goes unread.

## Testing

No test touches the network or runs `op`. Every GitHub interaction stays behind the injected
`fetchImpl`, and the disk layer takes an injected filesystem seam for the same reason: a test
asserts behaviour without writing to the operator's real state directory.

Per part, the behaviour that must be pinned by a test that fails when it is broken:

- Two concurrent cache misses produce exactly **one** fetch.
- A rejected in-flight fetch clears its entry, so the next request fetches again rather than
  inheriting the failure.
- A rejected pre-load leaves the server answering requests normally.
- A payload written and then read back round-trips, under the expected mode.
- Each corrupt-file case — absent, truncated, wrong shape, unknown schema — yields a cold
  start rather than an exception.
- A restored payload renders as stale with its original `fetchedAt`, never as fresh.
- The state summary counts each CI and review state correctly, including a group where every
  PR shares one state and a group where all differ.
- Reset clears collapse state as well as filters, and clears the persisted copy rather than
  only the in-memory one.

The parent spec's verification note still holds and is not improved by this work: nothing in
this project has ever talked to GitHub or 1Password from a test, by design.

## Deferred

- **A resident daemon.** See *Scope*. Revisit only if the 1Password prompt becomes the
  dominant cost, which the current measurement says it is not.
- **Pruning the persisted payload.** The whole file is replaced on each successful fetch, so
  individual stale entries never need removing.
- **Remembering collapse state per grouping axis.** Collapse keys are repository names and PR
  ids, so switching the grouping axis leaves them unread rather than misapplied. Per-axis
  state would be a refinement, not a fix.
