import { test } from 'node:test';
import assert from 'node:assert';
import { checkHost, checkSecret } from '../src/guard.ts';

const expected = { host: '127.0.0.1:8770', secret: 'sekrit' };
const good = {
  host: '127.0.0.1:8770',
  origin: 'http://127.0.0.1:8770',
  'x-pr-dash-secret': 'sekrit',
};

// The host assertions below used to run through `checkRequest`, which took the expected host
// *and* the expected secret and checked both. The server already checked the host on every
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

test('checkHost accepts a secretless request, which the page-shell navigation is', () => {
  // The whole reason the host half is a separate function: the server applies it to every
  // request, and the browser cannot attach `x-pr-dash-secret` to the address-bar navigation
  // that loads index.html. A checkHost that demanded the secret would 403 the page itself.
  const { 'x-pr-dash-secret': _omit, ...noSecret } = good;
  assert.deepStrictEqual(checkHost(noSecret, { host: expected.host }), { ok: true });
});

test('checkHost rejects an empty Host, which carries no host to compare', () => {
  const r = checkHost({ ...good, host: '' }, { host: expected.host });
  assert.strictEqual(r.ok, false);
});

test('accepts the right secret', () => {
  assert.deepStrictEqual(checkSecret(good, { secret: expected.secret }), { ok: true });
});

test('rejects a missing secret', () => {
  const { 'x-pr-dash-secret': _omit, ...noSecret } = good;
  const r = checkSecret(noSecret, { secret: expected.secret });
  assert.strictEqual(r.ok, false);
});

test('rejects a wrong secret', () => {
  const r = checkSecret({ ...good, 'x-pr-dash-secret': 'nope' }, { secret: expected.secret });
  assert.strictEqual(r.ok, false);
});

// A wrong secret of the same length as the right one is what proves the comparison itself
// rejects: any implementation that compares lengths first would pass this on the length
// alone.
test('rejects a wrong secret of the same length as the right one', () => {
  const sameLength = 'x'.repeat(expected.secret.length);
  assert.strictEqual(sameLength.length, expected.secret.length);
  const r = checkSecret({ ...good, 'x-pr-dash-secret': sameLength }, { secret: expected.secret });
  assert.strictEqual(r.ok, false);
});

test('rejects a secret that is a prefix of the right one', () => {
  const r = checkSecret({ ...good, 'x-pr-dash-secret': 'sek' }, { secret: expected.secret });
  assert.strictEqual(r.ok, false);
});

// This is the single-host-check invariant stated as a test: checkSecret does not look at the
// Host header at all, so host defence lives in exactly one place — the server's own
// unconditional `checkHost` call, which runs before any route is dispatched. A second host
// check here is what went dead and stayed dead.
test('checkSecret does not re-check the host, which the server already refused on', () => {
  const r = checkSecret({ ...good, host: 'evil.example.com:8770' }, { secret: expected.secret });
  assert.deepStrictEqual(r, { ok: true });
});
