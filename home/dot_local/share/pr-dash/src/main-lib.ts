import type { Client } from './github.ts';
import type { Cache } from './cache.ts';
import { createPrLoader, type LoadOpts, type LoadPrs, type LoadResult } from './loader.ts';
import type { PrRecord } from './types.ts';

// `stale` and `partialErrors` are independent, and the three states they describe are
// distinct: a complete fetch (neither), a partial fetch (errors, not stale — the rows are
// as fresh as `fetchedAt` says), and a retained payload after a failed refresh (stale). A
// retained payload that was itself partial carries both, which is why the flag travels
// with the payload rather than being recomputed per response.
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
      'already be running — open http://127.0.0.1:' +
      `${port}/ to check — or set PR_DASH_PORT to a free port.`
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  const codeSuffix = code === '' ? '' : ` (${code})`;
  return `pr-dash could not listen on 127.0.0.1:${port}${codeSuffix}: ${detail}`;
}

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
   * the restored rows on screen for up to the cache's TTL (or until a manual Refresh)
   * instead of the first fetch replacing them right away.
   */
  initial?: LoadResult;
  /**
   * Called after every successful resolution of `load` — a cache hit returning
   * previously-fetched data counts, not only a new GitHub fetch — for persisting the
   * payload. Synchronous and fire-and-forget by contract: a slow or failing disk must
   * not delay or fail the request that produced the payload. Must not return a Promise:
   * the wrapping try/catch below is synchronous and cannot catch a later rejection from
   * an async callback.
   */
  onSuccess?: (result: LoadResult) => void;
};

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

  // `loadOpts` is forwarded rather than dropped: this wrapper is what main.ts hands the
  // server, so a `force` that stops here never reaches the cache and the Refresh button
  // goes back to doing nothing.
  return async (loadOpts?: LoadOpts) => {
    // Answer from the retained payload rather than joining a fetch already in progress.
    // This is what the startup restore is for: the browser's first request arrives while
    // the pre-load is mid-flight, and joining it would make the page wait out the rest of
    // the GitHub round trip before painting anything. `refreshing` is how the fresh rows
    // still arrive without a click — the client asks again, and the poll lands on the
    // cache the pre-load populated rather than on a second GitHub fetch.
    //
    // Never for a forced call. The Refresh button exists to reach GitHub, so answering a
    // click from the retained payload would look like a button that does nothing.
    if (loadOpts?.force !== true && lastGood !== undefined && fetching > 0) {
      return { ...lastGood, stale: true, refreshing: true };
    }

    fetching += 1;
    try {
      const result = await load(loadOpts);
      // A partial result is retained like any other success. It is the most recent view of
      // the world, and not retaining it would mean a partial fetch followed by a failure
      // goes blank on a cold start — the outcome the spec calls worse than showing old
      // data. Its `partialErrors` ride along, so a retained partial never later renders
      // as complete.
      lastGood = result;
      // Wrapped: onSuccess writes to disk, and a full disk must not turn a successful
      // fetch into a failed request.
      try {
        opts.onSuccess?.(result);
      } catch {
        // Not persisted this time; the next successful fetch tries again.
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
 * launcher's readiness poll and the browser's cold start. By the time `app.js` requests
 * `/api/prs` the payload is already cached.
 *
 * Deliberately not awaited by the caller: awaiting before `listen()` delays the port past
 * the launcher's `curl` probe, which reintroduces the serial wait this exists to remove
 * and can push startup past the launcher's 60-second deadline.
 *
 * A failure here is not fatal and is not the page's problem. The loader caches only on
 * success, so the browser's own request retries against GitHub and renders the normal
 * error banner if that fails too. `onError` exists so the server can say so on stderr
 * rather than failing silently.
 */
export function startPreload(
  loadPrs: (opts?: LoadOpts) => Promise<FallbackResult>,
  onError: (message: string) => void = () => {},
): void {
  void loadPrs().catch((err: unknown) => {
    onError(err instanceof Error ? err.message : String(err));
  });
}
