import type { Client } from './github.ts';
import type { Cache } from './cache.ts';
import { createPrLoader, type LoadOpts, type LoadPrs, type LoadResult } from './loader.ts';
import type { PrRecord } from './types.ts';

// `stale` and `partialErrors` are independent, and the three states they describe are
// distinct: a complete fetch (neither), a partial fetch (errors, not stale — the rows are
// as fresh as `fetchedAt` says), and a retained payload after a failed refresh (stale). A
// retained payload that was itself partial carries both, which is why the flag travels
// with the payload rather than being recomputed per response.
export type FallbackResult = {
  prs: PrRecord[];
  fetchedAt: string;
  partialErrors: string[];
  stale: boolean;
  error?: string;
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
export function withFallback(load: LoadPrs): (opts?: LoadOpts) => Promise<FallbackResult> {
  let lastGood: LoadResult | undefined;

  // `opts` is forwarded rather than dropped: this wrapper is what main.ts hands the
  // server, so a `force` that stops here never reaches the cache and the Refresh button
  // goes back to doing nothing.
  return async (opts?: LoadOpts) => {
    try {
      const result = await load(opts);
      // A partial result is retained like any other success. It is the most recent view of
      // the world, and not retaining it would mean a partial fetch followed by a failure
      // goes blank on a cold start — the outcome the spec calls worse than showing old
      // data. Its `partialErrors` ride along, so a retained partial never later renders
      // as complete.
      lastGood = result;
      return { ...result, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return {
        ...lastGood,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      };
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
): (opts?: LoadOpts) => Promise<FallbackResult> {
  return withFallback(createPrLoader(client, cache));
}
