import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHost } from './guard.ts';
import { buildStacks } from './stacks.ts';
import type { PrRecord, StackNode } from './types.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export type ServerOpts = {
  // The host the launcher actually binds to and expects requests to arrive on. This is the
  // guard's expectation, and it must come from here rather than from the request's own Host
  // header — comparing a header to itself can never disagree, which is how the DNS
  // rebinding check went missing while every test still passed. It is read in exactly one
  // place, the `checkHost` call at the top of `handle`.
  host: string;
  // loadPrs carries its own fetchedAt rather than this module stamping one at response
  // time: a cache hit must report when the data was actually fetched, not the instant of
  // this particular request, or a client polling every few seconds would see a "just now"
  // timestamp on data that is up to the cache's TTL old.
  loadPrs: (opts?: { force?: boolean }) => Promise<{
    prs: PrRecord[];
    fetchedAt: string;
    stale?: boolean;
    error?: string;
    partialErrors?: string[];
    refreshing?: boolean;
  }>;
};

// Derived from opts.loadPrs's own return type rather than restating it: a hand-maintained
// copy closes the omission this round found (`refreshing` dropped at the wire) but not the
// class of it, since a field added only to FallbackResult and to loadPrs's declared return
// type still leaves a fourth copy, this one, unaware of it, and tsc has nothing to compare
// against. Deriving instead means a field added there flows into this type automatically,
// so the response literal below is the one place still missing it and `tsc` reports the
// same error that caught the original omission. `Required` strips every optional field's
// `?`, so nothing here can be silently left out; `error` is re-added as `string | null`
// because the handler coerces the optional `error?: string` to `null`, and `stacks` is
// added because it is not part of loadPrs's own return type at all.
type PrsResponseBody = Omit<Required<Awaited<ReturnType<ServerOpts['loadPrs']>>>, 'error'> & {
  stacks: StackNode[];
  error: string | null;
};

export function createServer(opts: ServerOpts): Server {
  return createHttpServer((req, res) => {
    void handle(req, res, opts).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
}

async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  opts: ServerOpts,
): Promise<void> {
  // The rebinding check runs first and covers every path, static assets included. Serving
  // index.html and app.js to a mismatched Host let an attacker's page host the dashboard's
  // own client code, and an absent Host is refused here too rather than defaulted: HTTP/1.1
  // requires it and there is nothing to compare the expectation against without it.
  const hostCheck = checkHost(req.headers, { host: opts.host });
  if (!hostCheck.ok) return refuse(res, 403, hostCheck.reason);

  // Only reads are served. No route here changes GitHub state, and a cross-origin form
  // POST is already refused above by the Host/Origin check, so this closes nothing
  // exploitable today; it is here because this is the endpoint surface a later mutating
  // route is added to, and a method gate costs less to add before that route exists than
  // after.
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
    res.end(JSON.stringify({ error: `method ${String(req.method)} is not allowed` }));
    return;
  }

  // The base is a fixed literal, never the request's own Host. Only `pathname` and
  // `searchParams` are read from this URL, so the base is irrelevant to the result — and
  // passing an unvalidated header in is how `Host: [` reached `new URL()` and threw, turning
  // a request the guard above had already refused into a 500 whose body named a TypeError.
  //
  // The request target is the other unvalidated value feeding this constructor, and Node's
  // HTTP parser does pass targets it rejects through verbatim: `//[` and `/\` both arrive at
  // this handler and both throw here. A malformed target is the client's error, so it is
  // answered as one rather than escaping to the 500 handler as an internal TypeError.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://pr-dash.invalid');
  } catch {
    refuse(res, 400, 'malformed request target');
    return;
  }

  // The shell contains no PR data, and nothing beyond the Host/Origin check above gates it.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic('index.html', res);
  }

  if (url.pathname === '/api/prs') {
    // The host was checked at the top of this function, unconditionally and before any
    // route was dispatched, which is the one place it lives. Nothing further gates this
    // route.
    // `?refresh=1` is the page's Refresh click, and only that exact value counts —
    // anything else in the query string is an ordinary poll served from the cache. The
    // comparison is the validation: no value from the URL reaches loadPrs, only a boolean.
    const force = url.searchParams.get('refresh') === '1';
    const { prs, fetchedAt, stale, error, partialErrors, refreshing } = await opts.loadPrs({ force });
    const body: PrsResponseBody = {
      prs,
      stacks: buildStacks(prs),
      fetchedAt,
      stale: stale ?? false,
      error: error ?? null,
      partialErrors: partialErrors ?? [],
      refreshing: refreshing ?? false,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  return serveStatic(url.pathname.replace(/^\//, ''), res);
}

/**
 * Ends `res` with a JSON `{ error }` body. One helper rather than a `writeHead`/`end` pair
 * per refusal, so every refused request answers in the same shape whatever refused it — the
 * three separate 403 bodies this replaced each had their own shape, one of them empty.
 */
function refuse(res: import('node:http').ServerResponse, status: number, reason: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: reason }));
}

// Exported so a test can call it directly with a `name` that never goes through the real
// request flow's own `new URL()` — see server.test.ts. The WHATWG URL parser resolves `..`
// and `%2e%2e` dot segments before `handle` ever reads `pathname`, so neither of this
// function's own two containment layers (the `safe` computation, the `startsWith` check)
// is reachable from a real HTTP request today. They stay load-bearing anyway: this is the
// one function a later caller — one that hands it an unnormalized name directly — would
// have to go through, and exporting it is what lets a test exercise that case now rather
// than after such a caller exists.
export async function serveStatic(name: string, res: import('node:http').ServerResponse): Promise<void> {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
  const path = join(PUBLIC_DIR, safe);
  if (!path.startsWith(PUBLIC_DIR)) {
    refuse(res, 403, 'path outside the public directory');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}
