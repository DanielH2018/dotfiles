import type { Client } from './github.ts';
import { fetchAllPrs } from './queries.ts';
import { normalize } from './normalize.ts';
import type { Cache } from './cache.ts';
import type { PrRecord } from './types.ts';

export type LoadResult = { prs: PrRecord[]; fetchedAt: string };

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
  return async function loadPrs(opts: LoadOpts = {}): Promise<LoadResult> {
    // Invalidating before the read, rather than skipping the read, is what makes the
    // TTL's own clock restart from this fetch: the fetch below repopulates the cache, so
    // polls resume hitting it instead of every later request re-fetching.
    if (opts.force === true) cache.invalidate();

    const hit = cache.get();
    if (hit !== undefined) return hit;

    // normalize() and cache.set() run only after fetchAllPrs resolves. A rejected fetch
    // propagates out of this function before either runs, so a failed refresh leaves
    // whatever was previously cached (or nothing, on a cold cache) untouched instead of
    // being overwritten with an empty or partial result.
    const prs = normalize(await fetchAllPrs(client));
    const result: LoadResult = { prs, fetchedAt: new Date().toISOString() };
    cache.set(result);
    return result;
  };
}
