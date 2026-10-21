import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { checkHost } from '../src/guard.ts';

const expected = { host: '127.0.0.1:8770' };
const good = {
  host: '127.0.0.1:8770',
  origin: 'http://127.0.0.1:8770',
};

// These assertions used to run through `checkRequest`, which took the expected host *and*
// the expected secret and checked both. The server already checked the host on every
// request before reaching it, so that second host check could never disagree with the first
// — a dead check, and one that stayed green when its expectation was swapped for the
// request's own Host header, which is exactly the defect that left this dashboard with no
// DNS-rebinding defence. The host check now lives in `checkHost` alone, and the vectors
// below exercise it there.
//
// The artifact server's guard (hooks/artifact-server/host_guard.py) reads the same vector
// file, so a rule changed in one guard and not the other fails one of the two suites. A
// null header in a vector means the request omits it.
type Vector = { name: string; expected_host: string; host: string | null; origin: string | null; allow: boolean };
const { vectors } = JSON.parse(
  readFileSync(new URL('../../../../../tests/fixtures/host-guard-vectors.json', import.meta.url), 'utf8'),
) as { vectors: Vector[] };

test('the shared host-guard vectors loaded', () => {
  assert.ok(vectors.length > 0);
});

for (const v of vectors) {
  test(v.name, () => {
    const headers: Record<string, string> = {};
    if (v.host !== null) headers['host'] = v.host;
    if (v.origin !== null) headers['origin'] = v.origin;
    assert.strictEqual(checkHost(headers, { host: v.expected_host }).ok, v.allow);
  });
}

// The path and CORS halves of the extension allowlist live in server.ts and are tested
// there. These pin the guard's own half: an exact match is reported, nothing near it is.
const extension = `chrome-extension://${'a'.repeat(32)}`;

test('reports an allowlisted extension origin instead of refusing it', () => {
  const r = checkHost({ ...good, origin: extension }, { ...expected, extensionOrigins: [extension] });
  assert.deepStrictEqual(r, { ok: true, extensionOrigin: extension });
});

test('matches an extension origin exactly, with no case-folding', () => {
  const r = checkHost(
    { ...good, origin: extension.toUpperCase() },
    { ...expected, extensionOrigins: [extension] },
  );
  assert.strictEqual(r.ok, false);
});
