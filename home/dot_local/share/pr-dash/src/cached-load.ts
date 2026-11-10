import type { Cache } from './cache.ts';
import { FORCE_MIN_INTERVAL_MS } from './main-lib.ts';

/**
 * A load result as a route serves it: `stale` marks a retained result behind a failed
 * refresh, and `error` says why that refresh failed.
 */
export type Served<T> = T & { stale: boolean; error?: string };

export type CachedLoad<T> = (opts?: { force?: boolean }) => Promise<Served<T>>;

/**
 * Wraps a per-repository fan-out (`fetchAll`) for a route the page polls.
 *
 * Joins an in-flight fetch rather than starting a second one, serves from `cache` until its
 * TTL lapses, and lets `force` bypass the cache at most once per {@link FORCE_MIN_INTERVAL_MS}.
 * When `fetchAll` rejects, the last good result is served marked stale; with nothing to fall
 * back on, the rejection propagates. Deciding when a fetch has failed outright (every
 * repository failing, say) is `fetchAll`'s job, not this wrapper's.
 */
export function createCachedLoad<T extends object>(
  fetchAll: () => Promise<T>,
  cache: Cache<T>,
  now: () => number = Date.now,
): CachedLoad<T> {
  let inFlight: Promise<T> | undefined;
  let lastGood: T | undefined;
  let lastForcedAt: number | undefined;

  return async function load(loadOpts = {}): Promise<Served<T>> {
    if (inFlight === undefined) {
      if (loadOpts.force === true) {
        const at = now();
        if (lastForcedAt === undefined || at - lastForcedAt >= FORCE_MIN_INTERVAL_MS) {
          lastForcedAt = at;
          cache.invalidate();
        }
      }
      const hit = cache.get();
      if (hit !== undefined) return { ...hit, stale: false };
      inFlight = fetchAll();
    }
    const pending = inFlight;
    try {
      const result = await pending;
      cache.set(result);
      lastGood = result;
      return { ...result, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return { ...lastGood, stale: true, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Cleared on rejection too, so one transient failure does not answer every later call.
      if (inFlight === pending) inFlight = undefined;
    }
  };
}
