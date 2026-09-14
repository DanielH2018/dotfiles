import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createServer } from '../src/server.ts';
import { createCache } from '../src/cache.ts';
import type { PrRecord } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

async function withServer(fn: (base: string, secret: string) => Promise<void>) {
  const secret = 'test-secret';
  const server = createServer({ secret, loadPrs: async () => records });
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

test('rejects /api/prs without the secret', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prs`);
    assert.strictEqual(res.status, 403);
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
