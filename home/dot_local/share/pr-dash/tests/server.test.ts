import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from '../src/server.ts';
import { createCache } from '../src/cache.ts';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

async function withServer(
  fn: (base: string, secret: string) => Promise<void>,
  loadPrs: () => Promise<{ prs: PrRecord[]; fetchedAt: string }> = async () => ({
    prs: records,
    fetchedAt: new Date().toISOString(),
  }),
) {
  const secret = 'test-secret';
  const server = createServer({ secret, loadPrs });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  try {
    await fn(`http://127.0.0.1:${addr.port}`, secret);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('serves records on /api/prs with the secret', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.prs.length, 2);
    assert.strictEqual(body.prs[0].id, 'acme/api#12');
  });
});

// Fix round 1: /api/prs sends stacks alongside prs and fetchedAt. Task 9's manual
// curl proved this once; nothing stops a later refactor dropping it silently.
test('/api/prs returns stacks alongside prs and fetchedAt', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    const body = await res.json();
    assert.ok(Array.isArray(body.prs));
    assert.ok(Array.isArray(body.stacks));
    assert.strictEqual(typeof body.fetchedAt, 'string');
    assert.strictEqual(body.stacks.length, body.prs.length);
  });
});

test('/api/prs reports the fetch time loadPrs gives it, not the response time', async () => {
  const fixedFetchedAt = '2020-01-01T00:00:00.000Z';
  await withServer(
    async (base, secret) => {
      const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
      const body = await res.json();
      assert.strictEqual(body.fetchedAt, fixedFetchedAt);
    },
    async () => ({ prs: records, fetchedAt: fixedFetchedAt }),
  );
});

test('rejects /api/prs without the secret', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prs`);
    assert.strictEqual(res.status, 403);
  });
});

// fetch() always sets a Host header from the URL, so a missing Host can only be
// exercised with a raw socket — this is what `nc` does manually against the real
// server. HTTP/1.0 does not require the client to send Host, which is exactly the
// case that used to reach `new URL()` with an empty host and throw, turning into
// a 500 instead of the 403 an absent Host should get.
function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('returns 403, not 500, when the Host header is missing', async () => {
  await withServer(async (base) => {
    const port = Number(new URL(base).port);
    const response = await rawRequest(port, 'GET /api/prs HTTP/1.0\r\n\r\n');
    assert.match(response, /^HTTP\/1\.1 403 /);
  });
});

test('cache returns a value until invalidated', () => {
  const c = createCache<number>(60_000);
  assert.strictEqual(c.get(), undefined);
  c.set(41);
  assert.strictEqual(c.get(), 41);
  c.invalidate();
  assert.strictEqual(c.get(), undefined);
});

test('cache expires after its ttl', () => {
  const c = createCache<number>(-1);
  c.set(1);
  assert.strictEqual(c.get(), undefined);
});
