import { createServer } from './server.ts';
import { createClient } from './github.ts';
import { createPrLoader, type LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';

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
const loadPrs = createPrLoader(client, cache);

const server = createServer({ secret, loadPrs });
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
