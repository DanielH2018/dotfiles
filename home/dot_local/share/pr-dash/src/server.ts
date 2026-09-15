import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequest } from './guard.ts';
import { buildStacks } from './stacks.ts';
import type { PrRecord } from './types.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export type ServerOpts = {
  secret: string;
  // The host the launcher actually binds to and expects requests to arrive on. Passed
  // through to the guard as `expected.host` rather than read off the request's own Host
  // header — comparing a header to itself can never disagree, which is how the DNS
  // rebinding check went missing while every test still passed.
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
  }>;
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
  // HTTP/1.1 requires a Host header; without one there is no host to build the
  // request URL against, and no host to check the guard against either. Refuse
  // outright rather than substituting a default, which is how an absent Host
  // used to reach `new URL()` and throw, turning into a 500 below instead of
  // the 403 a missing Host should be.
  const hostHeader = req.headers.host;
  if (hostHeader === undefined || hostHeader === '') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing Host header' }));
    return;
  }

  const guard = checkRequest(req.headers, { host: opts.host, secret: opts.secret });

  const url = new URL(req.url ?? '/', `http://${hostHeader}`);

  // The shell is fetched by the browser's address bar, which cannot send a
  // header, so it is served before the secret check. It contains no PR data.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic('index.html', res);
  }

  if (url.pathname === '/api/prs') {
    if (!guard.ok) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: guard.reason }));
      return;
    }
    // `?refresh=1` is the page's Refresh click, and only that exact value counts —
    // anything else in the query string is an ordinary poll served from the cache. The
    // comparison is the validation: no value from the URL reaches loadPrs, only a boolean.
    const force = url.searchParams.get('refresh') === '1';
    const { prs, fetchedAt, stale, error, partialErrors } = await opts.loadPrs({ force });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        prs,
        stacks: buildStacks(prs),
        fetchedAt,
        stale: stale ?? false,
        error: error ?? null,
        partialErrors: partialErrors ?? [],
      }),
    );
    return;
  }

  return serveStatic(url.pathname.replace(/^\//, ''), res);
}

async function serveStatic(name: string, res: import('node:http').ServerResponse): Promise<void> {
  const safe = normalize(name).replace(/^(\.\.[/\\])+/, '');
  const path = join(PUBLIC_DIR, safe);
  if (!path.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
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
