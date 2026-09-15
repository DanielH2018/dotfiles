import type { PrRecord } from './types.ts';

export type LoadResult = {
  prs: PrRecord[];
  fetchedAt: string;
  stale: boolean;
  error?: string;
};

// Extracted out of main.ts so poisoning the retained payload is testable without a real
// token, network, or clock — main.ts had no test at all before this, which is how
// `cache.set([])` on a failed refresh went unnoticed.
//
// `load`'s own success/failure is the only signal this needs: it doesn't know or care
// whether a success came from a fresh fetch or a cache hit, only that the page must never
// go blank on a failure that follows a success. `fetchedAt` here is stamped at the instant
// this wrapper last saw `load()` succeed — callers that need the underlying loader's own
// fetch timestamp (preserved across a cache hit) track that separately and override this
// field before handing the result to the server; see main.ts.
export function withFallback(load: () => Promise<PrRecord[]>): () => Promise<LoadResult> {
  let lastGood: PrRecord[] | undefined;
  let lastGoodAt = '';

  return async () => {
    try {
      const prs = await load();
      lastGood = prs;
      lastGoodAt = new Date().toISOString();
      return { prs, fetchedAt: lastGoodAt, stale: false };
    } catch (err) {
      if (lastGood === undefined) throw err;
      return {
        prs: lastGood,
        fetchedAt: lastGoodAt,
        stale: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
