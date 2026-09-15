import type { Client } from './github.ts';
import { fetchAllPrs } from './queries.ts';
import { normalize } from './normalize.ts';
import type { Cache } from './cache.ts';
import type { PrRecord } from './types.ts';

// `partialErrors` is empty on a complete fetch. Non-empty means `prs` is the subset of the
// user's PRs that GitHub actually returned, with these errors explaining the rest — a
// state distinct from both a complete fetch and a retained stale payload.
export type LoadResult = { prs: PrRecord[]; fetchedAt: string; partialErrors: string[] };

// `force` is what the page's Refresh control sends. It is a per-call option rather than a
// separate function so the one code path serves both: an automatic poll or a first page
// load omits it and is served from the cache, while a click reaches GitHub.
export type LoadOpts = { force?: boolean };

export type LoadPrs = (opts?: LoadOpts) => Promise<LoadResult>;

// Wires a GitHub client and a cache into the loadPrs function the server calls on every
// /api/prs request. Kept separate from main.ts so this logic — cache hit/miss, and what
// happens to the cache when a fetch fails — can be tested without a real token, a real
// network, or a real clock; main.ts stays the thin process-level shell that builds the
// client and cache from the environment and hands them here.
export function createPrLoader(client: Client, cache: Cache<LoadResult>): LoadPrs {
  // The fetch currently running, if any. Without this, the startup pre-load and the
  // browser's first /api/prs both miss the cache and both run a full paginated query
  // against the rate limit, racing to cache.set.
  let inFlight: Promise<LoadResult> | undefined;

  return async function loadPrs(opts: LoadOpts = {}): Promise<LoadResult> {
    // Joining an in-flight fetch never touches the cache: that fetch is already as fresh as
    // a new one would be, and invalidating on the way past can discard a result it has
    // just written.
    if (inFlight !== undefined) return inFlight;

    // Invalidating before the read, rather than skipping the read, is what makes the
    // TTL's own clock restart from this fetch: the fetch below repopulates the cache, so
    // polls resume hitting it instead of every later request re-fetching.
    if (opts.force === true) cache.invalidate();

    const hit = cache.get();
    if (hit !== undefined) return hit;

    // normalize() and cache.set() run only after fetchAllPrs resolves. A rejected fetch
    // propagates before either runs, so a failed refresh leaves whatever was previously
    // cached (or nothing, on a cold cache) untouched instead of being overwritten with
    // an empty or partial result.
    const pending = (async (): Promise<LoadResult> => {
      const fetched = await fetchAllPrs(client);
      const result: LoadResult = {
        prs: normalize(fetched.prs),
        fetchedAt: new Date().toISOString(),
        partialErrors: fetched.errors,
      };
      cache.set(result);
      return result;
    })();

    inFlight = pending;
    try {
      return await pending;
    } finally {
      // Cleared on rejection as well as on success. A retained rejected promise would be
      // handed to every later caller, so one transient failure would never heal.
      inFlight = undefined;
    }
  };
}
