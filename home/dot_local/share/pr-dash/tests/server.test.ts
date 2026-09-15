import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import { createServer } from '../src/server.ts';
import { createCache } from '../src/cache.ts';
import type { PrRecord, StackNode } from '../src/types.ts';

const records: PrRecord[] = JSON.parse(
  readFileSync(new URL('./fixtures/records.json', import.meta.url), 'utf8'),
);

// Collects every PR id reachable from a stack forest, root and child alike. Used to
// check that the forest represents each PR exactly once -- the property that holds
// regardless of whether any PR nests under another, unlike `stacks.length`, which
// only equals `prs.length` when nothing does.
function flattenIds(nodes: readonly StackNode[]): string[] {
  return nodes.flatMap((node) => [node.pr.id, ...flattenIds(node.children)]);
}

// createServer's `host` option must be known before construction, but an ephemeral
// port (`listen(0, ...)`) is only known after the real server is already listening.
// Probing with a throwaway listener first, then closing it and reusing the port it
// found, breaks that chicken-and-egg problem for the test helper below.
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const addr = probe.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  const port = addr.port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function withServer(
  fn: (base: string, secret: string) => Promise<void>,
  loadPrs: (opts?: { force?: boolean }) => Promise<{ prs: PrRecord[]; fetchedAt: string }> = async () => ({
    prs: records,
    fetchedAt: new Date().toISOString(),
  }),
) {
  const secret = 'test-secret';
  const port = await freePort();
  const server = createServer({ secret, host: `127.0.0.1:${port}`, loadPrs });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${port}`, secret);
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
//
// Fix round 3: the original assertion here was `stacks.length === prs.length`,
// which only holds when nothing in the fixture is actually stacked -- one PR
// nesting under another collapses two prs into one root, and that assertion would
// fail on a perfectly correct response. This fixture puts acme/api#13 on top of
// acme/api#12 (its headRef becomes #13's baseRef) precisely so the two counts
// differ: 3 prs, but 2 roots (#12 with #13 nested under it, and acme/web#7 on its
// own). The property that actually holds regardless of stacking is that every PR
// id appears exactly once across the flattened forest.
test('/api/prs returns stacks alongside prs and fetchedAt, one entry per PR', async () => {
  const stacked: PrRecord[] = [
    records[0]!,
    {
      ...records[0]!,
      id: 'acme/api#13',
      number: 13,
      url: 'https://github.com/acme/api/pull/13',
      headRef: 'followup',
      baseRef: records[0]!.headRef,
    },
    records[1]!,
  ];
  await withServer(
    async (base, secret) => {
      const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
      const body = await res.json();
      assert.ok(Array.isArray(body.prs));
      assert.ok(Array.isArray(body.stacks));
      assert.strictEqual(typeof body.fetchedAt, 'string');
      assert.strictEqual(body.stacks.length, 2);
      const flattened = flattenIds(body.stacks).sort();
      assert.deepStrictEqual(flattened, stacked.map((r) => r.id).sort());
    },
    async () => ({ prs: stacked, fetchedAt: new Date().toISOString() }),
  );
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

test('/api/prs forwards stale and error from loadPrs', async () => {
  await withServer(
    async (base, secret) => {
      const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
      const body = await res.json();
      assert.strictEqual(body.stale, true);
      assert.strictEqual(body.error, 'network down');
    },
    async () => ({ prs: records, fetchedAt: new Date().toISOString(), stale: true, error: 'network down' }),
  );
});

test('/api/prs reports stale as false, not omitted, when loadPrs does not set it', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    const body = await res.json();
    assert.strictEqual(body.stale, false);
  });
});

test('/api/prs reports error as null, not omitted, when loadPrs does not set it', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    const body = await res.json();
    assert.strictEqual(body.error, null);
  });
});

test('/api/prs forwards partialErrors from loadPrs', async () => {
  // The banner's only source for "some PRs are missing" is this field on the wire.
  // Without a test that reads it back off a real response, dropping it from the JSON
  // body leaves every test green and the banner permanently silent, because
  // parsePrsBody coerces the absent field to an empty array.
  await withServer(
    async (base, secret) => {
      const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
      const body = await res.json();
      assert.deepStrictEqual(body.partialErrors, ['search timed out']);
      // A partial fetch has just succeeded, so it is not stale.
      assert.strictEqual(body.stale, false);
    },
    async () => ({
      prs: records,
      fetchedAt: new Date().toISOString(),
      partialErrors: ['search timed out'],
    }),
  );
});

test('/api/prs reports partialErrors as an empty array, not omitted, on a complete fetch', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    const body = await res.json();
    assert.deepStrictEqual(body.partialErrors, []);
  });
});

test('/api/prs?refresh=1 asks loadPrs to bypass the cache', async () => {
  /** Every `force` value loadPrs was called with, in request order. */
  const forces: (boolean | undefined)[] = [];
  await withServer(
    async (base, secret) => {
      const headers = { 'x-pr-dash-secret': secret };
      await fetch(`${base}/api/prs`, { headers });
      await fetch(`${base}/api/prs?refresh=1`, { headers });
      // Only the literal `1` counts: a poll that happens to carry some other query
      // string must not silently turn into a forced GitHub fetch.
      await fetch(`${base}/api/prs?refresh=0`, { headers });
      await fetch(`${base}/api/prs?refresh=yes`, { headers });
      assert.deepStrictEqual(forces, [false, true, false, false]);
    },
    async (opts) => {
      forces.push(opts?.force);
      return { prs: records, fetchedAt: new Date().toISOString() };
    },
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

test('rejects a Host header that is not the configured one', async () => {
  const server = createServer({
    secret: 'test-secret',
    host: '127.0.0.1:9999',
    loadPrs: async () => ({ prs: records, fetchedAt: new Date().toISOString() }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/prs`, {
      headers: { 'x-pr-dash-secret': 'test-secret' },
    });
    assert.strictEqual(res.status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
