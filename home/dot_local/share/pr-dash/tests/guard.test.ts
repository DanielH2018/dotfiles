import { test } from 'node:test';
import assert from 'node:assert';
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
// DNS-rebinding defence. The host check now lives in `checkHost` alone, and these exercise
// it there.
test('accepts a well-formed same-origin host', () => {
  assert.deepStrictEqual(checkHost(good, { host: expected.host }), { ok: true });
});

test('accepts localhost as an alias for 127.0.0.1', () => {
  const r = checkHost({ ...good, host: 'localhost:8770' }, { host: 'localhost:8770' });
  assert.strictEqual(r.ok, true);
});

test('rejects an attacker hostname resolved to loopback', () => {
  const r = checkHost({ ...good, host: 'evil.example.com:8770' }, { host: expected.host });
  assert.strictEqual(r.ok, false);
});

test('rejects a cross-origin request', () => {
  const r = checkHost({ ...good, origin: 'https://evil.example.com' }, { host: expected.host });
  assert.strictEqual(r.ok, false);
});

test('allows an absent Origin, which same-origin GETs omit', () => {
  const { origin: _omit, ...noOrigin } = good;
  assert.deepStrictEqual(checkHost(noOrigin, { host: expected.host }), { ok: true });
});

test('checkHost rejects an empty Host, which carries no host to compare', () => {
  const r = checkHost({ ...good, host: '' }, { host: expected.host });
  assert.strictEqual(r.ok, false);
});
