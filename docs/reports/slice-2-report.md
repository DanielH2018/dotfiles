# Slice 2 report: lazy token resolution and the idle exit

Worktree: `/Users/daniel/.local/share/chezmoi/.claude/worktrees/pr-dash-always-on`
Package: `home/dot_local/share/pr-dash`
Commit: `19fcd68b4b49c2d2df8eea29af37f9976e4cd1a3`

## Baseline

- `npm test`: 425 passing, 0 failing.
- `npm run check` (`tsc --noEmit`): exit 0.

## After this slice

- `npm test`: 446 passing, 0 failing (21 new tests).
- `npm run check`: exit 0.

## The seam chosen, and why

`src/main-lib.ts` gets three new pieces, all exported and unit-testable without `op`, a
network, a real clock, or a real server:

- **`createLazyToken(resolve)`** memoizes a `TokenSource`. It shares one in-flight promise
  across concurrent callers (`pending`), and remembers only a success (`cached`) — a
  rejection clears `pending` in a `finally` and leaves `cached` unset, so the next call
  starts a fresh resolution rather than replaying a dismissed prompt forever. This is the
  same `inFlight`-then-clear idiom `createPrLoader` already uses for the GitHub fetch
  itself, just with a second "don't clear on success" layer added.
- **`createLazyClient(getToken, makeClient)`** returns a `Client` whose `query` awaits
  `getToken()` and only then calls `makeClient(token)`. It adds no caching of its own —
  `getToken` already does that — and rebuilds the underlying client on every call, on the
  strength of `createClient` being stateless. This is what lets `main.ts` hand
  `createLoadPrs` a `Client` before any token exists: `createPrLoader` and `withFallback`
  are unchanged, because from their point of view this is just a `Client`.
- **`createIdleExit(opts)`** owns a single timer handle. `touch()` cancels whatever is
  pending and schedules a fresh, `unref`'d timer that calls `exit(0)`. `setTimeoutFn` /
  `clearTimeoutFn` / `exit` are all injectable so tests never wait 30 minutes or actually
  exit the process.

`main.ts` wires `getToken = createLazyToken(() => resolveToken(process.env))` and
`client = createLazyClient(getToken, (token) => createClient({ token }))` in place of the
old `let token; try { token = await resolveToken(...) } catch { process.exit(1) }` block.
Nothing on the startup path calls `resolveToken` — it only runs inside the async chain a
real query triggers.

**The token failure's route to the client needed no new plumbing.** A rejected
`client.query` propagates through `createPrLoader` and `withFallback` exactly like any
other fetch failure: on a cold start with no restored payload, `withFallback` rethrows and
`createServer`'s existing catch-all turns that into a 500 whose body is
`JSON.stringify({ error: String(err) })` — which already contains `err.message`, i.e.
`resolveToken`'s own text. Verified end-to-end in
`tests/server.test.ts` ("a token resolution failure on a cold start reaches the client as
a 500 ..."), driving a real `createServer`/`createLoadPrs`/`createLazyClient`/
`createLazyToken` composition through a real HTTP request, not just at the seam.

**The idle-exit re-arm hook lives in `server.ts`, not wired through `server.on('request')`
in `main.ts`.** An `onRequest?: () => void` field on `ServerOpts`, called as the first
statement in `handle()`, before the Host check and every other route decision. That
ordering is what makes a refused request re-arm the timer — a `server.on('request', ...)`
listener added from outside would technically fire for the same requests too, but nothing
would prove that in a test without also exercising the 403 path through the real handler,
so I put the hook where `tests/server.test.ts` could drive real requests (a good one, a
static asset, and a mismatched Host) straight at it.

## `unref` reasoning

The timer is `unref`'d. The listening socket, not this timer, is what keeps the process
alive: it's a `ref`'d libuv handle for as long as `server.listen()` is open, independent
of anything scheduled elsewhere. `unref` on the idle timer does not stop it from firing —
the event loop keeps ticking on the socket's account regardless of the timer's ref state —
it only matters if some later change closes the server while the timer is still pending:
without `unref`, the process would then sit for up to another 30 minutes running a
callback whose only job is exiting a process that already has nothing left to serve. Ref'd
would have worked too (this process never closes its own socket), but `unref` is the
correct default for "this timer's job is never to be the reason the process is still
running."

## Mutations run, one line each

Every mutation was applied to the real source, run against the test(s) meant to catch it,
confirmed red, then reverted and re-verified clean (`npm run check` + the affected test
file) before moving on.

- Disabled `pending` sharing in `createLazyToken` → reddened "two concurrent callers
  resolve the token exactly once" and the rejection-sharing test.
- Removed the `cached !== undefined` short-circuit → reddened "a successful resolution is
  reused for later calls, not re-run".
- Removed the `finally` that clears `pending` on rejection → reddened "a rejected
  resolution is not cached" and its concurrent variant.
- Made `createLazyClient` call `getToken()` eagerly at construction → reddened "does not
  resolve the token until a query is made".
- Added `console.error('resolved', token)` inside `createLazyToken` → reddened the
  main-lib.ts no-logging leak-scan test.
- `exit(1)` instead of `exit(0)` in `createIdleExit` → reddened "exits with status 0".
- Removed `handle.unref?.()` → reddened "touch schedules a timer that unrefs itself".
- Removed the cancel-before-reschedule in `touch()` (stacking bug) → reddened both the
  re-arm test and the burst test.
- Reordered `touch()` to cancel the *new* handle instead of the old one → reddened all
  four idle-exit behavioral tests (exit, re-arm, burst, mid-window request).
- Moved `server.ts`'s `onRequest?.()` call to after the Host check → reddened "onRequest
  fires even for a request the Host check goes on to refuse".
- Stripped the message out of `createServer`'s 500 body (`'internal error'` instead of
  `String(err)`) → reddened the end-to-end token-failure 500 test.
- Added a stray `console.error(token)` in `main.ts`'s `createLazyClient` callback →
  reddened "main.ts uses the identifier token only in its known-safe places" (now 3, not
  4, occurrences).
- Reintroduced `await resolveToken(process.env)` at the top level of `main.ts` → reddened
  "main.ts does not await resolveToken directly".
- Dropped the `onRequest` option from `main.ts`'s `createServer` call → reddened "main.ts
  arms an idle exit and touches it from every server request".

## Comments fixed (Part 3)

- `startPreload`'s doc comment in `main-lib.ts`: kept its accurate claim about *when*
  `onError` fires, and added a paragraph on *what* now reaches it on a cold start — a
  dismissed Touch ID prompt's failure, via `resolveToken`'s own remediation text, landing
  in the launchd log (stderr) rather than anywhere the operator would see it if they never
  opened the browser.
- `main.ts`'s own comments: replaced the eager-resolution block comment (`let token; try
  {...}`) with one describing the lazy wiring; extended the pre-load comment to note the
  fetch it starts now also resolves the token; added a comment on the new
  `createIdleExit` wiring.

`bin/pr-dash`'s ready-probe comment (`home/dot_local/bin/executable_pr-dash`, lines
14-16) is now inaccurate too — it explains the `curl` probe in terms of the server
resolving its token via 1Password *before* it listens, which is exactly the behavior this
slice removes. That file is explicitly reworked in the spec's "The launchd agent" section,
out of this slice's Parts 1-3, so I left it alone rather than editing a script this slice
wasn't asked to touch; flagging it here per the "docs change in the same PR as the code"
rule, for whoever picks up that section.

## What the spec got wrong (or at least understates)

The spec's "Lazy token resolution" intro says "the first Touch ID prompt arrives when the
operator first opens the dashboard." That is not quite what this design (correctly, per
the explicit test requirements) implements: `main.ts` still calls `startPreload` before
`listen()`, unawaited, and that pre-load is exactly what triggers `resolveToken` — at
process start, not at the operator's first request. The task's own bullet list is explicit
about this overlap ("the startup pre-load and the browser's first request overlap by
design"), so I built to that, not to the intro's looser phrasing. The practical
consequence: under `KeepAlive` + the 30-minute idle exit, a Touch ID prompt fires once per
respawn cycle even if nobody ever opens the dashboard — at login, and again every 30
minutes after that for as long as the process keeps getting respawned with no requests.
That is a real behavior a later reviewer should know about; it isn't something this slice's
Parts 1-3 gave me room to change (deferring the pre-load itself to first-request would
break the "startup pre-load ... overlap[s] ... by design" property the task tests for), so
I'm surfacing it rather than acting on it.

## Properties I could not pin

- The `createLazyToken`/`createLazyClient` "resolves once" tests use `resolve`'s own call
  count as the primary oracle, which is the direct property under test here (not a proxy
  for something else, unlike the anti-pattern the task warns about) — but I also assert the
  two concurrent callers receive the *same* value from a resolver that returns a distinct
  value per call, so a broken implementation that starts a second resolution instead of
  joining the first can't pass by coincidence.
- `createLazyClient`'s "does not cache a client" behavior (rebuilding via `makeClient` on
  every call) has no dedicated test — it falls out of the implementation being five lines
  with no client-level cache, and is called out in that function's own doc comment as a
  design choice resting on `createClient` being stateless, for a future editor to
  reconsider if that stops being true. I did not write a test asserting `makeClient` is
  called once-per-query rather than once-per-getToken-resolution, since that's an
  implementation detail with no externally observable effect given `createClient`'s actual
  statelessness — a test asserting the call count would be exactly the "stub call count"
  anti-pattern the task warns against.
- I did not add a test pinning the *ordering* between `createLazyToken(` and
  `createLazyClient(` in `main.ts` beyond a textual index comparison
  (`startup-order.test.ts`). Any implementation that compiles has to construct `getToken`
  before passing it to `createLazyClient`, so this test is closer to documentation of
  intent than a mutation-catching guard — I could not find a plausible incorrect
  implementation that would still typecheck and reverse the order, so I did not chase a
  mutation for it.

## Files changed

- `src/main-lib.ts` — added `TokenSource`, `createLazyToken`, `createLazyClient`,
  `IDLE_TIMEOUT_MS`, `IdleExitOpts`, `IdleExit`, `createIdleExit`. Extended
  `startPreload`'s doc comment.
- `src/main.ts` — replaced eager `resolveToken`/`createClient` wiring with the lazy
  version; added the idle-exit wiring and `onRequest` hook; updated comments.
- `src/server.ts` — added `onRequest?: () => void` to `ServerOpts`; calls it as the first
  statement in `handle()`, before the Host check.
- `tests/lazy-token.test.ts` (new) — `createLazyToken`/`createLazyClient` unit tests, plus
  the main-lib.ts no-logging leak scan.
- `tests/idle-exit.test.ts` (new) — `createIdleExit` unit tests with an injected fake
  timer.
- `tests/server.test.ts` — `onRequest` wiring tests (success path, refused-Host path), and
  the end-to-end token-failure-to-500 test.
- `tests/startup-order.test.ts` — updated the token-occurrence count (3, not 4) and its
  rationale comment; added three new structural pins for the lazy-token and idle-exit
  wiring in `main.ts`.

`src/token.ts` was not modified.
