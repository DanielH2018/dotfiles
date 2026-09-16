import type { Client, QueryResult } from './github.ts';
import type { Cache } from './cache.ts';
import { createPrLoader, type LoadOpts, type LoadPrs, type LoadResult } from './loader.ts';
import type { PrRecord } from './types.ts';

/** The loopback port the dashboard listens on when `PR_DASH_PORT` is unset. */
export const DEFAULT_PORT = 8770;

export type ParsedPort = { ok: true; port: number } | { ok: false; reason: string };

// Validated with a regex and a range check rather than `Number()`, which accepts far too
// much: `Number('')` is 0, `Number('0x22')` is 34, `Number(' 8770 ')` strips the spaces,
// and `Number.isInteger(Number('8770.0'))` is true. The empty string is the case that
// actually broke the dashboard — `listen(0)` binds a random port while the guard still
// expects `127.0.0.1:0`, so every request 403s behind a banner the user cannot escape.
/**
 * Reads the port from a raw `PR_DASH_PORT` value, falling back to {@link DEFAULT_PORT}
 * when it is unset. A value that is not a positive integer in the 1-65535 range is
 * rejected with a message naming both the variable and what was read.
 */
export function parsePort(raw: string | undefined): ParsedPort {
  if (raw === undefined) return { ok: true, port: DEFAULT_PORT };
  const reject = {
    ok: false as const,
    reason: `PR_DASH_PORT must be a port number between 1 and 65535, but it is "${raw}".`,
  };
  if (!/^\d+$/.test(raw)) return reject;
  const port = Number(raw);
  if (port < 1 || port > 65535) return reject;
  return { ok: true, port };
}

/** The port a client omits from an http `Host` header, being the scheme's default. */
const HTTP_DEFAULT_PORT = 80;

/**
 * The loopback authority the guard must expect for a server listening on `port`.
 *
 * Port 80 is left off, because browsers and curl both omit a scheme's default port from the
 * `Host` header: a server on port 80 receives `Host: 127.0.0.1`, so expecting
 * `127.0.0.1:80` refuses every request. That takes the launcher's readiness probe with it —
 * the probe gets the same 403, its loop never exits, and it reports "did not start
 * listening within 60s" about a server that is listening fine. `parsePort` accepts 80, so
 * this is reachable, if only for a caller running as root.
 *
 * 443 is not special here: this server speaks http only, so a client reaching
 * `http://127.0.0.1:443` sends that port explicitly.
 */
export function expectedHost(port: number): string {
  return port === HTTP_DEFAULT_PORT ? '127.0.0.1' : `127.0.0.1:${port}`;
}

/**
 * The message to print when `server.listen` fails. Without an `'error'` handler Node
 * prints a raw `node:events` stack trace over a condition the user can simply act on, so
 * an occupied port names the port and the variable that moves it. Every other failure is
 * reported as itself: calling an EACCES "port in use" would send the user hunting for a
 * process that does not exist.
 */
export function listenErrorMessage(err: unknown, port: number): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (code === 'EADDRINUSE') {
    return (
      `Port ${port} is already in use, so pr-dash cannot start. Another pr-dash may ` +
      `already be running — run \`lsof -i :${port}\` to see what holds it, or set ` +
      'PR_DASH_PORT to a free port.'
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  const codeSuffix = code === '' ? '' : ` (${code})`;
  return `pr-dash could not listen on 127.0.0.1:${port}${codeSuffix}: ${detail}`;
}

/**
 * `stale` and `partialErrors` are independent, and the three states they describe are
 * distinct: a complete fetch (neither), a partial fetch (errors, not stale — the rows are
 * as fresh as `fetchedAt` says), and a retained payload after a failed refresh (stale). A
 * retained payload that was itself partial carries both, which is why the flag travels
 * with the payload rather than being recomputed per response.
 */
export type FallbackResult = {
  prs: PrRecord[];
  fetchedAt: string;
  partialErrors: string[];
  stale: boolean;
  error?: string;
  /**
   * True only on a retained payload served while a fetch is running, which tells the client
   * to ask again shortly instead of waiting. Absent on every other outcome, including a
   * retained payload behind a *failed* fetch — there, `error` names the failure and asking
   * again would just repeat it.
   */
  refreshing?: boolean;
};

export type FallbackOpts = {
  /**
   * A payload restored from disk. Seeds the retained-payload slot, **not** the cache: a
   * seeded cache would make the startup pre-load a cache hit and skip the fetch, leaving
   * the restored rows on screen for up to the cache's TTL (or until a manual Refresh).
   * Seeded here instead, the rows answer the first request through the prime path and the
   * fetch still runs, so the rows the fetch returns replace them as soon as it lands.
   */
  initial?: LoadResult;
  /**
   * Called once per distinct successful result `load` produces, with two exceptions that
   * combine: a result is not re-notified once a call to this has already returned for it,
   * but a call that throws leaves that result eligible again. So when two concurrent
   * callers join the same in-flight fetch (a cold start with no seed, before either has a
   * retained payload to answer from) and this throws on the first of them, the second
   * still sees the result as un-notified and this is called again with the same result. A
   * consumer that is not idempotent must guard against that itself.
   * Synchronous and fire-and-forget by contract: a slow or failing disk must not delay
   * or fail the request that produced the payload. Must not return a Promise: the
   * wrapping try/catch below is synchronous and cannot catch a later rejection from an
   * async callback.
   */
  onSuccess?: (result: LoadResult) => void;
  /**
   * The clock the force throttle reads. Defaults to `Date.now`, and is injectable for the
   * same reason `createIdleExit` takes its timer: a test must be able to move time without
   * waiting for it.
   */
  now?: () => number;
};

// A forced fetch invalidates the cache and reaches GitHub, and with the per-launch secret
// gone any local process can ask for one — see the always-on spec's "Dropping the per-launch
// secret". Ten seconds is below what an operator clicking Refresh would notice and bounds a
// loop to 360 fetches an hour rather than as many as the caller can issue.
export const FORCE_MIN_INTERVAL_MS = 10_000;

// Extracted out of main.ts so poisoning the retained payload is testable without a real
// token, network, or clock — main.ts had no test at all before this, which is how
// `cache.set([])` on a failed refresh went unnoticed.
//
// `load` returns its own `fetchedAt` alongside `prs`, and both are captured in the one
// `lastGood` assignment below — not tracked as two separate variables written at
// different times. That single source of truth is what a cache hit's true fetch time
// (as opposed to the instant this wrapper happens to run) actually needs: splitting
// `prs` and `fetchedAt` into two variables, one inside this closure and one held by a
// caller, lets two concurrent calls interleave and pair one call's retained `prs` with
// a different call's `fetchedAt`.
export function withFallback(
  load: LoadPrs,
  opts: FallbackOpts = {},
): (loadOpts?: LoadOpts) => Promise<FallbackResult> {
  let lastGood: LoadResult | undefined = opts.initial;
  // How many calls are inside `load` right now. A count, not a boolean: two requests can be
  // awaiting at once, and the shortcut below must stay open until the last of them settles.
  let fetching = 0;
  // The last result object handed to onSuccess, tracked by reference so a cache hit or a
  // dedup-joined in-flight fetch — both of which resolve to the exact same object a prior
  // call already persisted — does not write it to disk a second time. On a cold start with
  // no seed, two concurrent callers both skip the shortcut above (there is nothing to serve
  // yet) and both land here once `load` resolves; without this check both would call
  // onSuccess for what is, underneath, one real fetch.
  let lastNotified: LoadResult | undefined;
  // False until the first call has been answered. Under the launchd agent nothing pre-loads,
  // so the browser's first request is the one that would otherwise wait out the whole token
  // resolution and GitHub round trip. That request gets the restored payload and the fetch
  // starts behind it; every later request takes the normal path, where `fetching > 0` covers
  // the overlap and a completed fetch is a cache hit.
  let primed = false;
  const now = opts.now ?? Date.now;
  // When the last forced fetch was allowed through, or undefined before the first one. The
  // first force is never throttled: the bound is on the interval between them, so a single
  // Refresh click always reaches GitHub however long the process has been up.
  let lastForcedAt: number | undefined;

  // Whether this call may reach GitHub with the cache invalidated. A force inside
  // FORCE_MIN_INTERVAL_MS is downgraded to an ordinary request rather than rejected: it
  // falls through to the cache and answers promptly, which is what a caller asking too
  // often should get, where an error would make the page render a failure over rows that
  // are seconds old.
  function allowForce(): boolean {
    const at = now();
    if (lastForcedAt !== undefined && at - lastForcedAt < FORCE_MIN_INTERVAL_MS) return false;
    lastForcedAt = at;
    return true;
  }

  // The awaited path, extracted so the background fetch the prime path starts runs exactly
  // the same code — including the retained-payload catch and the `fetching` bookkeeping —
  // rather than a second copy of it. `fetching += 1` is the first statement and runs
  // synchronously, before the caller's `await`, which is what lets the prime path return
  // while a request arriving behind it still sees `fetching > 0`.
  async function callLoad(loadOpts?: LoadOpts): Promise<FallbackResult> {
    fetching += 1;
    try {
      const result = await load(loadOpts);
      // A partial result is retained like any other success. It is the most recent view of
      // the world, and not retaining it would mean a partial fetch followed by a failure
      // goes blank on a cold start — the outcome the spec calls worse than showing old
      // data. Its `partialErrors` ride along, so a retained partial never later renders
      // as complete.
      lastGood = result;
      if (result !== lastNotified) {
        // Wrapped: onSuccess writes to disk, and a full disk must not turn a successful
        // fetch into a failed request. lastNotified is set only after onSuccess returns,
        // so a throw leaves this result eligible to be offered again on the next call
        // instead of being skipped forever.
        try {
          opts.onSuccess?.(result);
          lastNotified = result;
        } catch {
          // Not persisted this time; the next successful fetch tries again.
        }
      }
      return { ...result, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return {
        ...lastGood,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Decremented on rejection as well as on success. A counter left above zero would
      // keep the shortcut open forever, so every later request would answer from the
      // retained payload and the dashboard would never show a fresh fetch again.
      fetching -= 1;
    }
  }

  // `loadOpts` is forwarded rather than dropped: this wrapper is what main.ts hands the
  // server, so a `force` that stops here never reaches the cache and the Refresh button
  // goes back to doing nothing.
  return async (loadOpts?: LoadOpts) => {
    // Set before the force check, and unconditionally. If a forced call could leave this
    // false, an operator whose first action is clicking Refresh would leave the flag unset,
    // and the next poll would take the prime path and start a second background fetch while
    // the forced one is still running.
    const firstCall = !primed;
    primed = true;

    // A downgraded force is forwarded as an ordinary request, so it reads the cache instead
    // of invalidating it; an allowed one is forwarded exactly as it arrived.
    const forced = loadOpts?.force === true && allowForce();
    const effectiveOpts: LoadOpts | undefined =
      loadOpts?.force === true && !forced ? { ...loadOpts, force: false } : loadOpts;

    // The first request is answered from the restored payload with the fetch started behind
    // it, rather than waiting for it. This is the path the launchd agent actually uses: it
    // sets no PR_DASH_PRELOAD, so nothing is in flight when the browser's first /api/prs
    // arrives, and awaiting here means a blank page for the whole of the token resolution,
    // the Touch ID prompt and the paginated GraphQL query.
    if (!forced && lastGood !== undefined && firstCall && fetching === 0) {
      // Rejection is swallowed on purpose: this response is already committed, and the next
      // request takes the normal path, where a persistent failure surfaces through the catch
      // in callLoad as an error on the retained payload. Re-throwing here would reach an
      // unhandled rejection with nobody to receive it.
      void callLoad(effectiveOpts).catch(() => {});
      return { ...lastGood, stale: true, refreshing: true };
    }

    // Answer from the retained payload rather than joining a fetch already in progress.
    // This covers both the pre-load path, where the browser's first request arrives while
    // the pre-loaded fetch is mid-flight, and the request that lands behind the prime path
    // above; joining either would make the page wait out the rest of the GitHub round trip
    // before painting anything. `refreshing` is how the fresh rows still arrive without a
    // click — the client asks again, and the poll lands on the cache that fetch populated
    // rather than on a second GitHub fetch.
    //
    // Never for a forced call. The Refresh button exists to reach GitHub, so answering a
    // click from the retained payload would look like a button that does nothing.
    if (!forced && lastGood !== undefined && fetching > 0) {
      return { ...lastGood, stale: true, refreshing: true };
    }

    return callLoad(effectiveOpts);
  };
}

// The composition main.ts wires together at startup: a real GitHub client and cache
// feed createPrLoader, and withFallback sits on top so a failed refresh retains the
// last good payload instead of going blank. Kept here rather than inline in main.ts so
// this assembly is itself covered by a test (see refresh.test.ts) — main.ts carries no
// test coverage at all, being a process shell that reads env vars and calls
// process.exit, so any wiring left there is untested by construction.
export function createLoadPrs(
  client: Client,
  cache: Cache<LoadResult>,
  opts: FallbackOpts = {},
): (opts?: LoadOpts) => Promise<FallbackResult> {
  return withFallback(createPrLoader(client, cache), opts);
}

/**
 * Starts the first fetch without waiting for it, so the GitHub round trip overlaps the
 * launcher's readiness poll and the browser's cold start.
 *
 * Deliberately not awaited by the caller: awaiting before `listen()` delays the port past
 * the launcher's `curl` probe, which reintroduces the serial wait this exists to remove
 * and can push startup past the launcher's 60-second deadline.
 *
 * `onError` fires only when the page itself has no way to say a fetch failed. With a
 * restored payload seeded as `initial` (see `withFallback`), a failed fetch resolves to
 * that payload marked stale rather than rejecting, and the operator reads the failure in
 * the page's own stale banner instead — `onError` never runs on that path. It runs only on
 * a cold start with nothing restored, where `withFallback` still rejects and the page has
 * no prior payload to show a banner over, so stderr is the only place left to say so.
 *
 * That cold-start case is also the one place a dismissed Touch ID prompt on the very first
 * launch surfaces at all: `loadPrs` now resolves the GitHub token as part of this same
 * fetch (see `createLazyToken`/`createLazyClient`), and under launchd stderr is the launchd
 * log, so `resolveToken`'s message — the exact `op` command to run — is what an operator
 * who never opened the browser would find there.
 */
export function startPreload(
  loadPrs: (opts?: LoadOpts) => Promise<FallbackResult>,
  onError: (message: string) => void = () => {},
): void {
  void loadPrs().catch((err: unknown) => {
    onError(err instanceof Error ? err.message : String(err));
  });
}

/**
 * Whether the startup pre-load should run — see the always-on design's "The pre-load
 * becomes opt-in". `bin/pr-dash` is the single caller that sets this, because that path is
 * about to open a browser and the fetch can overlap the wait. Under launchd there is no
 * browser start to overlap and no operator present to answer the Touch ID prompt an
 * unconditional pre-load would raise at every respawn, so the agent leaves it unset.
 *
 * The comparison is strict and exactly `'1'`. This is a knob one script sets, not a
 * user-facing boolean, so `'true'`, `'yes'` and `'0'` are all off — the narrow contract
 * makes the enabled case unambiguous at the single call site that sets it.
 */
export function preloadEnabled(env: NodeJS.ProcessEnv): boolean {
  return env['PR_DASH_PRELOAD'] === '1';
}

/** A function that resolves the GitHub token, such as `resolveToken` bound to `process.env`. */
export type TokenSource = () => Promise<string>;

// A failed resolution is not retained for the process's life — a dismissed prompt must not
// poison the process, which is the invariant lazy-token.test.ts pins. It is retained for a
// few seconds, because the page polls a 500 every 600ms for a minute and each retry would
// otherwise spawn another `op`, re-prompting for biometrics the operator just dismissed.
export const TOKEN_FAILURE_TTL_MS = 5_000;

export type LazyTokenOpts = {
  /** The clock the negative cache reads. Defaults to `Date.now`; injectable for tests. */
  now?: () => number;
};

// Extracted out of main.ts so the concurrency and failure-caching properties are testable
// without a real `op` process or an actual Touch ID prompt. This is the seam the always-on
// design's "Lazy token resolution" section describes: main.ts no longer resolves the token
// before it listens, so `resolve` here only ever runs once something (the startup pre-load,
// or the browser's own first /api/prs) actually needs GitHub.
//
// Only success is remembered indefinitely. A rejection — the operator dismissing a biometric
// prompt, or `op` failing for any other reason — must not poison the process for its
// remaining life, so `cached` stays unset on that path and a later call starts a fresh
// resolution instead of replaying the same failure forever. A failure is retained for
// TOKEN_FAILURE_TTL_MS, no longer, for the reason on that constant.
export function createLazyToken(resolve: TokenSource, opts: LazyTokenOpts = {}): TokenSource {
  const now = opts.now ?? Date.now;
  let cached: string | undefined;
  let pending: Promise<string> | undefined;
  let failure: { error: unknown; at: number } | undefined;

  return async function getToken(): Promise<string> {
    // Ahead of the negative cache, so a success can never be shadowed by an earlier
    // failure — which is also why nothing clears `failure` on the success path.
    if (cached !== undefined) return cached;
    if (pending !== undefined) return pending;
    if (failure !== undefined) {
      if (now() - failure.at < TOKEN_FAILURE_TTL_MS) throw failure.error;
      failure = undefined;
    }

    // Assigned before the await, the same way createPrLoader's own inFlight is: a second
    // caller arriving before this one resumes must see `pending` already set and return
    // the same promise, or the startup pre-load and the browser's first request each start
    // their own `op` process and the operator sees two Touch ID prompts for one page load.
    const attempt = resolve();
    pending = attempt;
    try {
      const token = await attempt;
      cached = token;
      return token;
    } catch (err) {
      failure = { error: err, at: now() };
      throw err;
    } finally {
      pending = undefined;
    }
  };
}

/**
 * A {@link Client} whose token is resolved by `getToken` on first use rather than at
 * construction, so it can be built and handed to `createLoadPrs` before a token exists.
 *
 * `getToken` is expected to memoize its own resolution (see {@link createLazyToken}); this
 * wrapper adds no caching of its own. `makeClient` runs again on every query rather than
 * once, on the strength of `createClient` being stateless — it only closes over the token
 * and an optional `fetchImpl` — so rebuilding it per call costs nothing worth caching.
 */
export function createLazyClient(
  getToken: TokenSource,
  makeClient: (token: string) => Client,
): Client {
  return {
    async query<T>(query: string, variables: Record<string, unknown>): Promise<QueryResult<T>> {
      const token = await getToken();
      return makeClient(token).query<T>(query, variables);
    },
  };
}

/**
 * How long the server waits with no request before exiting — see the always-on design's
 * "The idle exit". A security knob, not a performance one: it bounds how long the resolved
 * GitHub token stays in memory, not how efficiently the process runs. Asserted against the
 * literal `1_800_000` in idle-exit.test.ts, so a future change to this value is visible
 * there instead of silently changing the window.
 */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** The minimal shape this module needs from a scheduled timer, real or injected in a test. */
type TimerHandle = { unref?: () => void };

export type IdleExitOpts = {
  timeoutMs?: number;
  /** Defaults to `process.exit`. Injectable so a test never actually ends the process. */
  exit?: (code: number) => void;
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
};

export type IdleExit = {
  /** Re-arms the idle window. Called once per request, from every route, refused or not. */
  touch: () => void;
};

// The process's listening socket, not this timer, is what keeps the event loop alive: it is
// a ref'd handle for as long as the server is open, independent of anything scheduled here.
// `unref` below just keeps this timer from being an additional reason to stay alive on its
// own — it does not stop the callback from firing on an otherwise-idle process, because the
// loop is still ticking on the socket's account, not this timer's. It matters only if some
// later change closes the server out from under a pending timer: without `unref` the process
// would then sit for up to another IDLE_TIMEOUT_MS waiting to run a callback whose only job
// is exiting a process that already has nothing left to serve.
export function createIdleExit(opts: IdleExitOpts = {}): IdleExit {
  const timeoutMs = opts.timeoutMs ?? IDLE_TIMEOUT_MS;
  // Wrapped rather than passed as `process.exit`, which would be an unbound method. It
  // works — Node's implementation closes over `process` rather than reading `this` — but no
  // test covers this path, since every test here injects its own `exit`, so the arrow
  // removes the dependency on that internal detail instead of resting on it.
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const scheduleTimeout: (callback: () => void, ms: number) => TimerHandle =
    opts.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const cancelTimeout: (handle: TimerHandle) => void =
    opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

  let handle: TimerHandle | undefined;

  function touch(): void {
    // Cancelled before the next one is scheduled, not after — a burst of requests must
    // leave exactly one pending timer, never one more piled up per request.
    if (handle !== undefined) cancelTimeout(handle);
    handle = scheduleTimeout(() => {
      // Status 0, not a thrown error: under launchd's KeepAlive this is the intended way
      // the process ends, and anything else would make launchd log a crash for what is,
      // on purpose, just the token's turn to be forgotten and the port's turn to be
      // reclaimed by a fresh process.
      exit(0);
    }, timeoutMs);
    handle.unref?.();
  }

  touch();
  return { touch };
}
