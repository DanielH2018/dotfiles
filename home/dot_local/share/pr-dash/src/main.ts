import { createServer } from './server.ts';
import { createClient } from './github.ts';
import type { LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import { createLoadPrs, expectedHost, listenErrorMessage, parsePort } from './main-lib.ts';

const secret = process.env['PR_DASH_SECRET'];
if (secret === undefined || secret === '') {
  console.error('PR_DASH_SECRET is not set. Start the dashboard with `pr-dash`.');
  process.exit(1);
}
const parsedPort = parsePort(process.env['PR_DASH_PORT']);
if (!parsedPort.ok) {
  console.error(parsedPort.reason);
  process.exit(1);
}
const port = parsedPort.port;

let token: string;
try {
  token = await resolveToken(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const client = createClient({ token });
const cache = createCache<LoadResult>(60_000);
const loadPrs = createLoadPrs(client, cache);

const server = createServer({ secret, host: expectedHost(port), loadPrs });
// Attached before listen(): without a handler, an occupied port reaches Node's default
// 'error' behaviour and prints a `node:events` throw trace over a condition the user can
// act on in one step.
server.on('error', (err: unknown) => {
  console.error(listenErrorMessage(err, port));
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`pr-dash listening on http://127.0.0.1:${port}`);
});
