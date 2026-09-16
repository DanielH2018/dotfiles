import { createServer } from './server.ts';
import { createClient } from './github.ts';
import type { LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import {
  createIdleExit,
  createLazyClient,
  createLazyToken,
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

// Resolved lazily rather than here: under launchd there is no interactive session to answer
// 1Password's Touch ID prompt at startup, so calling resolveToken before listen made an
// unavailable vault fatal and invisible — the agent restarted, failed the same way, and the
// operator saw a port refusing connections with nothing to read. createLazyClient defers
// resolveToken to the first query a real fetch makes, and createLazyToken is what makes that
// resolution run once and get shared by whichever caller needs GitHub first.
const getToken = createLazyToken(() => resolveToken(process.env));
const client = createLazyClient(getToken, (token) => createClient({ token }));
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
// restored, that request instead waits out this same fetch — which now also resolves the
// token (see getToken above), so a Touch ID prompt can be part of that wait too.
startPreload(loadPrs, (message) => {
  console.error(`pr-dash could not pre-load PRs (the page will retry): ${message}`);
});

// Exits the process after 30 minutes with no request, so the token this process resolved
// does not stay in memory indefinitely — see createIdleExit. Created before the server so
// the window is already running from process start, not just from the first request.
const idleExit = createIdleExit();
const server = createServer({
  host: expectedHost(port),
  loadPrs,
  onRequest: () => idleExit.touch(),
});
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
