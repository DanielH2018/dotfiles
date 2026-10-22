import { createServer } from './server.ts';
import { createClient } from './github.ts';
import type { LoadResult } from './loader.ts';
import { resolveToken } from './token.ts';
import { createCache } from './cache.ts';
import { createLoadJobs } from './jobs.ts';
import { createLoadPlanka } from './planka.ts';
import {
  createIdleExit,
  createLazyClient,
  createLazyToken,
  createLoadPrs,
  expectedHost,
  listenErrorMessage,
  parseExtensionOrigins,
  parsePort,
  parseWorkOrgs,
  preloadEnabled,
  startPreload,
} from './main-lib.ts';
import { createPayloadStore, DEFAULT_STATE_DIR } from './payload-store.ts';
import { createVulnLoader, parseVulnRepos, type VulnLoadResult } from './vulns.ts';

const parsedPort = parsePort(process.env['PR_DASH_PORT']);
if (!parsedPort.ok) {
  console.error(parsedPort.reason);
  process.exit(1);
}
const port = parsedPort.port;

// Parsed before anything else runs, so a malformed entry stops the process before it reads
// the payload store, resolves a token, or listens. A typo in an access allowlist must not
// start a server whose boundary differs from the one the operator configured.
const parsedExtensionOrigins = parseExtensionOrigins(process.env['PR_DASH_EXTENSION_ORIGINS']);
if (!parsedExtensionOrigins.ok) {
  console.error(parsedExtensionOrigins.reason);
  process.exit(1);
}
// Refused at startup for a related reason: a typo here would silently drop a repository from
// the vulnerabilities page, which then reads as that repository having no open alerts.
const parsedVulnRepos = parseVulnRepos(process.env['PR_DASH_VULN_REPOS']);
if (!parsedVulnRepos.ok) {
  console.error(parsedVulnRepos.reason);
  process.exit(1);
}

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

// Exits the process after 16 hours with no request — see createIdleExit and IDLE_TIMEOUT_MS.
// The token's own max age (TOKEN_MAX_AGE_MS) bounds how long it stays in memory. Created before the server so
// the window is already running from process start, not just from the first request.
const idleExit = createIdleExit();
const server = createServer({
  host: expectedHost(port),
  // Unset on a machine that never configured it, which parseWorkOrgs reads as an empty
  // list — the client then treats every repository as work and the Personal toggle has
  // nothing to hide. The launchd agent takes its value from the rendered plist.
  workOrgs: parseWorkOrgs(process.env['PR_DASH_WORK_ORGS']),
  // Unset on a machine that never configured it, which accepts no extension origin. The
  // launchd agent takes its value from the rendered plist.
  extensionOrigins: parsedExtensionOrigins.origins,
  loadPrs,
  // Spawns the planka CLI per request, never at startup, so a machine without it pays
  // nothing until something asks for /api/planka.
  loadPlanka: createLoadPlanka(),
  // Spawns jobstat per request for the same reason: most machines never ask for /api/jobs.
  loadJobs: createLoadJobs(),
  // Shares the PR loader's lazy client, so both routes resolve the token once. Alerts change
  // far more slowly than PR state, hence the longer TTL than the PR cache's 60 seconds.
  loadVulns: createVulnLoader(client, parsedVulnRepos.repos, createCache<VulnLoadResult>(300_000)),
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
