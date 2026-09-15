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

test('/api/prs forwards refreshing from loadPrs', async () => {
  // Fix round 2: the handler used to destructure five named fields into an explicit
  // object literal, which dropped refreshing at the wire silently -- a bare object
  // literal handed to JSON.stringify is typed any, so tsc caught nothing.
  await withServer(
    async (base, secret) => {
      const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
      const body = await res.json();
      assert.strictEqual(body.refreshing, true);
    },
    async () => ({
      prs: records,
      fetchedAt: new Date().toISOString(),
      stale: true,
      refreshing: true,
    }),
  );
});

test('/api/prs reports refreshing as false, not omitted, when loadPrs does not set it', async () => {
  await withServer(async (base, secret) => {
    const res = await fetch(`${base}/api/prs`, { headers: { 'x-pr-dash-secret': secret } });
    const body = await res.json();
    assert.strictEqual(body.refreshing, false);
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
    // Not just "something refused": the reorder this branch guards against leaves this
    // request 403ing on the *secret* instead, since a raw socket sends neither header. The
    // status alone cannot tell those apart, so the reason is what pins the host half.
    assert.match(response, /unexpected Host/);
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
    // The secret sent here is the right one, so a refusal naming the secret would mean the
    // host check had not run. The reason distinguishes which half refused, and the host
    // half is the one that has to: it is the only defence against a rebinding attacker,
    // who can read the secret out of the URL fragment they were handed.
    const body = await res.json();
    assert.match(body.error, /Host/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// The host and origin halves of the guard apply to every request, not just /api/prs. Only
// the per-launch secret is scoped to the API, because the browser cannot attach a custom
// header to the navigation that loads the page shell. Every test below drives a raw socket:
// `fetch` derives Host from the URL and forbids overriding it, so a mismatched or malformed
// Host is only reachable this way.

function rawAt(base: string, request: string): Promise<string> {
  return rawRequest(Number(new URL(base).port), request);
}

test('serves the page shell at / to the expected Host', async () => {
  await withServer(async (base) => {
    const port = new URL(base).port;
    const response = await rawAt(
      base,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 200 /);
    assert.match(response, /<title>PR Dashboard<\/title>/);
  });
});

test('serves the page shell to the localhost spelling of the expected Host', async () => {
  // The guard's documented 127.0.0.1/localhost aliasing has to survive being applied to the
  // static branch too, or a launcher URL spelled `localhost` would 403 the page it opened.
  await withServer(async (base) => {
    const port = new URL(base).port;
    const response = await rawAt(
      base,
      `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 200 /);
  });
});

test('rejects / from a mismatched Host instead of serving the page shell', async () => {
  await withServer(async (base) => {
    const response = await rawAt(
      base,
      'GET / HTTP/1.1\r\nHost: evil.example.com:8770\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.doesNotMatch(response, /<title>PR Dashboard<\/title>/);
  });
});

test('rejects a static asset from a mismatched Host', async () => {
  await withServer(async (base) => {
    const response = await rawAt(
      base,
      'GET /app.js HTTP/1.1\r\nHost: evil.example.com:8770\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.doesNotMatch(response, /render-guards/);
  });
});

test('rejects a cross-origin Origin on the page shell, not only on the API', async () => {
  await withServer(async (base) => {
    const port = new URL(base).port;
    const response = await rawAt(
      base,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        'Origin: https://evil.example.com\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403 /);
  });
});

test('answers a malformed Host with 403, not a 500 carrying a TypeError', async () => {
  // `Host: [` is not a parseable URL authority. The guard has already decided to refuse
  // this request; passing the header on into `new URL()` afterwards is what turned the
  // refusal into `{"error":"TypeError: Invalid URL"}` at 500.
  await withServer(async (base) => {
    const response = await rawAt(
      base,
      'GET /api/prs HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.doesNotMatch(response, /TypeError/);
  });
});

test('answers an unparseable request target with 400, not a 500 carrying a TypeError', async () => {
  // The same defect as the malformed-Host case above, reached through the other value that
  // feeds `new URL()`. Node's HTTP parser passes `//[` and `/\` through to the handler
  // verbatim (verified over a raw socket), and both throw in the URL constructor, so
  // without this the refusal arrives as a 500 whose body names an internal TypeError.
  await withServer(async (base) => {
    const port = new URL(base).port;
    for (const target of ['//[', '/\\']) {
      const response = await rawAt(
        base,
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(response, /^HTTP\/1\.1 400 /, `target ${target}`);
      assert.doesNotMatch(response, /TypeError/, `target ${target}`);
    }
  });
});

test('refuses POST /api/prs with 405 even when the host and secret are right', async () => {
  // Nothing on this surface mutates GitHub state and a cross-origin form POST cannot set
  // the secret header, so this is not a live hole. The check is here because this endpoint
  // surface is what a later mutating route gets added to, and a method gate costs less
  // before that route exists than after.
  await withServer(async (base, secret) => {
    const port = new URL(base).port;
    const response = await rawAt(
      base,
      `POST /api/prs HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `x-pr-dash-secret: ${secret}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 405 /);
    assert.match(response, /allow: GET/i);
  });
});

test('refuses DELETE / with 405 instead of serving the page shell', async () => {
  await withServer(async (base) => {
    const port = new URL(base).port;
    const response = await rawAt(
      base,
      `DELETE / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 405 /);
    assert.doesNotMatch(response, /<title>PR Dashboard<\/title>/);
  });
});
