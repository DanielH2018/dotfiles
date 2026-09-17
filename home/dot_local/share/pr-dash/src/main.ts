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
  parseWorkOrgs,
  preloadEnabled,
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

// Opt-in, via PR_DASH_PRELOAD — see preloadEnabled. `bin/pr-dash` sets it because that path
// is about to open a browser, and starting the fetch before listen() overlaps the launcher's
// port poll and the browser's own cold start. The launchd agent does not set it: its server
// is listening long before anyone opens the bookmark, so there is no browser start left to
// overlap, and the restored payload above paints instantly anyway — withFallback's prime
// path answers the first request from it and runs the fetch behind that response, so nothing
// here has to be in flight for the page to paint. An unconditional pre-load would also
// resolve the token at every respawn — a
// Touch ID prompt with nobody present, defeating the idle exit's only purpose of not holding
// the token in memory between requests.
if (preloadEnabled(process.env)) {
  startPreload(loadPrs, (message) => {
    console.error(`pr-dash could not pre-load PRs (the page will retry): ${message}`);
  });
}

// Exits the process after 30 minutes with no request, so the token this process resolved
// does not stay in memory indefinitely — see createIdleExit. Created before the server so
// the window is already running from process start, not just from the first request.
const idleExit = createIdleExit();
const server = createServer({
  host: expectedHost(port),
  // Unset on a machine that never configured it, which parseWorkOrgs reads as an empty
  // list — the client then treats every repository as work and the Personal toggle has
  // nothing to hide. The launchd agent takes its value from the rendered plist.
  workOrgs: parseWorkOrgs(process.env['PR_DASH_WORK_ORGS']),
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
