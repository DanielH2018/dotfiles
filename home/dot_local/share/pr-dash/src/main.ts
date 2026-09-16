import { createServer } from './server.ts';
import { createClient } from './github.ts';
import type { LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import {
  createLoadPrs,
  expectedHost,
  listenErrorMessage,
  parsePort,
  startPreload,
} from './main-lib.ts';
import { createPayloadStore, DEFAULT_STATE_DIR } from './payload-store.ts';

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
const store = createPayloadStore(DEFAULT_STATE_DIR);
// Read before the server starts, so the first /api/prs can answer from it while the
// pre-loaded fetch started below is still running.
const restored = await store.read();
const loadPrs = createLoadPrs(client, cache, {
  initial: restored,
  onSuccess: (result) => {
    void store.write(result);
  },
});

// Started before listen() and not awaited, so it overlaps the launcher's port poll and the
// browser's start instead of delaying them. The one request it does not beat is answered
// from the restored payload above when there is one; on a first-ever launch, with nothing
// restored, that request instead waits out this same fetch.
startPreload(loadPrs, (message) => {
  console.error(`pr-dash could not pre-load PRs (the page will retry): ${message}`);
});

const server = createServer({ host: expectedHost(port), loadPrs });
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
