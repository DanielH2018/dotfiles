// main.ts is a process shell — it reads env vars and calls process.exit, so it carries no
// test coverage by construction. The decisions it makes before the server can serve a
// request are extracted into main-lib.ts and tested here: what counts as a usable port,
// what the user is told when listening on it fails, and whether the startup pre-load runs.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  parsePort,
  parseWorkOrgs,
  listenErrorMessage,
  expectedHost,
  preloadEnabled,
  DEFAULT_PORT,
} from '../src/main-lib.ts';

test('an unset PR_DASH_WORK_ORGS yields no work organizations', () => {
  // Which the client reads as "no constraint": every repository counts as work and the
  // Personal toggle hides nothing. The opposite reading would open a blank dashboard on
  // any machine that never configured the variable.
  assert.deepStrictEqual(parseWorkOrgs(undefined), []);
  assert.deepStrictEqual(parseWorkOrgs(''), []);
  assert.deepStrictEqual(parseWorkOrgs('  ,  ,'), []);
});

test('work organizations are split on commas, trimmed, and lowercased', () => {
  // Lowercased because GitHub owner names are case-insensitive while the nameWithOwner the
  // records carry preserves the owner's own casing.
  assert.deepStrictEqual(parseWorkOrgs('Acme'), ['acme']);
  assert.deepStrictEqual(parseWorkOrgs('acme, Acme-Labs '), ['acme', 'acme-labs']);
  assert.deepStrictEqual(parseWorkOrgs('acme,,acme-labs'), ['acme', 'acme-labs']);
});

// Item 5 of the final review: `127.0.0.1:${port}` is wrong for port 80. Browsers and curl
// both omit a default port from the Host header, so the guard's expectation has to omit it
// too or every request 403s — including the launcher's readiness probe, which then reports
// "did not start listening within 60s" about a server that is listening fine.
test('the expected host omits port 80, which clients do not send', () => {
  assert.strictEqual(expectedHost(80), '127.0.0.1');
});

test('the expected host carries every other port, which clients do send', () => {
  assert.strictEqual(expectedHost(DEFAULT_PORT), `127.0.0.1:${DEFAULT_PORT}`);
  assert.strictEqual(expectedHost(8080), '127.0.0.1:8080');
  // 443 is the *https* default. This server only ever speaks http, so a client asking for
  // http://127.0.0.1:443 sends the port explicitly and the expectation must keep it.
  assert.strictEqual(expectedHost(443), '127.0.0.1:443');
});

test('an unset PR_DASH_PORT falls back to the default port', () => {
  const parsed = parsePort(undefined);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.ok && parsed.port, DEFAULT_PORT);
});

test('a plain port number is accepted', () => {
  const parsed = parsePort('9001');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.ok && parsed.port, 9001);
});

for (const raw of ['1', '65535']) {
  test(`the boundary port ${raw} is accepted`, () => {
    const parsed = parsePort(raw);
    assert.strictEqual(parsed.ok, true, `expected ${raw} to be a usable port`);
  });
}

// Every entry here is a value `Number()` would have accepted, which is why the guard is a
// regex and a range check rather than `Number.isInteger(Number(raw))`. The empty string is
// the case that actually reached production: `Number('')` is 0, so `listen(0)` bound a
// random port while the guard still expected `127.0.0.1:0`, and every request then 403'd
// behind a banner the user could not escape.
for (const raw of ['', '0', '-1', '8770.0', '0x22', ' 8770 ', '65536', '1e4', 'abc', 'NaN']) {
  test(`the port ${JSON.stringify(raw)} is rejected`, () => {
    const parsed = parsePort(raw);
    assert.strictEqual(parsed.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
    assert.match(!parsed.ok ? parsed.reason : '', /PR_DASH_PORT/);
  });
}

test('the rejection names the offending value so the user can see what was read', () => {
  const parsed = parsePort('http://8770');
  assert.strictEqual(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.reason : '', /http:\/\/8770/);
});

test('an EADDRINUSE names the port and the variable that changes it', () => {
  const err = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
    code: 'EADDRINUSE',
  });
  const message = listenErrorMessage(err, 8770);
  assert.match(message, /8770/);
  assert.match(message, /already in use/i);
  assert.match(message, /PR_DASH_PORT/);
});

test('a non-EADDRINUSE failure is reported as itself, naming its code', () => {
  // Reporting every listen failure as "port in use" would send the user hunting for a
  // process that does not exist. EACCES on a low port is the realistic case.
  const err = Object.assign(new Error('listen EACCES: permission denied'), { code: 'EACCES' });
  const message = listenErrorMessage(err, 80);
  assert.match(message, /EACCES/);
  assert.doesNotMatch(message, /already in use/i);
});

test('a failure carrying no code still produces a message naming the port', () => {
  const message = listenErrorMessage(new Error('something else went wrong'), 8770);
  assert.match(message, /8770/);
  assert.match(message, /something else went wrong/);
});

test('a thrown non-Error does not break the message', () => {
  const message = listenErrorMessage('just a string', 8770);
  assert.match(message, /8770/);
  assert.match(message, /just a string/);
});

test('preloadEnabled is true only for exactly "1"', () => {
  assert.strictEqual(preloadEnabled({ PR_DASH_PRELOAD: '1' }), true);
});

// The narrow contract is deliberate — this is a knob bin/pr-dash sets, not a user-facing
// boolean, so every other spelling of "on" stays off.
for (const raw of [undefined, '', '0', 'true', 'yes']) {
  test(`preloadEnabled is false for ${JSON.stringify(raw)}`, () => {
    const env = raw === undefined ? {} : { PR_DASH_PRELOAD: raw };
    assert.strictEqual(preloadEnabled(env), false);
  });
}
