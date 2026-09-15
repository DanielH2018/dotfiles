import { test } from 'node:test';
import assert from 'node:assert';
import { checkHost, checkRequest } from '../src/guard.ts';

const expected = { host: '127.0.0.1:8770', secret: 'sekrit' };
const good = {
  host: '127.0.0.1:8770',
  origin: 'http://127.0.0.1:8770',
  'x-pr-dash-secret': 'sekrit',
};

test('accepts a well-formed same-origin request', () => {
  assert.deepStrictEqual(checkRequest(good, expected), { ok: true });
});

test('accepts localhost as an alias for 127.0.0.1', () => {
  const r = checkRequest({ ...good, host: 'localhost:8770' }, { ...expected, host: 'localhost:8770' });
  assert.strictEqual(r.ok, true);
});

test('rejects an attacker hostname resolved to loopback', () => {
  const r = checkRequest({ ...good, host: 'evil.example.com:8770' }, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a cross-origin request', () => {
  const r = checkRequest({ ...good, origin: 'https://evil.example.com' }, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a missing secret', () => {
  const { 'x-pr-dash-secret': _omit, ...noSecret } = good;
  const r = checkRequest(noSecret, expected);
  assert.strictEqual(r.ok, false);
});

test('rejects a wrong secret', () => {
  const r = checkRequest({ ...good, 'x-pr-dash-secret': 'nope' }, expected);
  assert.strictEqual(r.ok, false);
});

test('allows an absent Origin, which same-origin GETs omit', () => {
  const { origin: _omit, ...noOrigin } = good;
  assert.deepStrictEqual(checkRequest(noOrigin, expected), { ok: true });
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
