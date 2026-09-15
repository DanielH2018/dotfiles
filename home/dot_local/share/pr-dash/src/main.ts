import { createServer } from './server.ts';
import { createClient } from './github.ts';
import { createPrLoader, type LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import { withFallback } from './main-lib.ts';

const secret = process.env['PR_DASH_SECRET'];
if (secret === undefined || secret === '') {
  console.error('PR_DASH_SECRET is not set. Start the dashboard with `pr-dash`.');
  process.exit(1);
}
const port = Number(process.env['PR_DASH_PORT'] ?? 8770);

let token: string;
try {
  token = await resolveToken(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const client = createClient({ token });
const cache = createCache<LoadResult>(60_000);
const loadPrsRaw = createPrLoader(client, cache);

// withFallback tracks its own "last good" state purely in terms of PrRecord[], so its
// own fetchedAt is stamped fresh on every successful call -- including a cache hit,
// which would make a client polling within the cache TTL see "just now" on data that
// hasn't actually been re-fetched (the regression loader.ts's own fetchedAt handling
// was written to avoid). lastGoodFetchedAt tracks the loader's real timestamp instead,
// updated only when loadPrsRaw actually resolves, so it stays correct across both a
// cache hit (the loader's original fetch time) and a fallback (the last time a fetch
// truly succeeded).
let lastGoodFetchedAt = '';
const loadWithFallback = withFallback(async () => {
  const result = await loadPrsRaw();
  lastGoodFetchedAt = result.fetchedAt;
  return result.prs;
});
const loadPrs = async () => {
  const result = await loadWithFallback();
  return { ...result, fetchedAt: lastGoodFetchedAt };
};

const server = createServer({ secret, loadPrs });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
