import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRequest } from './guard.ts';
import type { PrRecord } from './types.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export type ServerOpts = {
  secret: string;
  loadPrs: () => Promise<PrRecord[]>;
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
  const hostHeader = req.headers.host ?? '';
  // The expected host here is the request's own Host header, which makes this
  // particular check a tautology — it can never disagree with itself. Task 12
  // replaces it with the launcher's configured host. Until then, the Origin and
  // secret checks below are what actually carry the guard.
  const guard = checkRequest(req.headers, { host: hostHeader, secret: opts.secret });

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
    const prs = await opts.loadPrs();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ prs, fetchedAt: new Date().toISOString() }));
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
