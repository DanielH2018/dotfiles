import { createServer } from './server.ts';
import { createClient } from './github.ts';
import { fetchAllPrs } from './queries.ts';
import { normalize } from './normalize.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import type { PrRecord } from './types.ts';

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
const cache = createCache<PrRecord[]>(60_000);

async function loadPrs(): Promise<PrRecord[]> {
  const hit = cache.get();
  if (hit !== undefined) return hit;
  const records = normalize(await fetchAllPrs(client));
  cache.set(records);
  return records;
}

const server = createServer({ secret, loadPrs });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
