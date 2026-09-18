// tests/lib/probe.js: a present tool reads as present, a missing one as missing, and the skip
// string names the missing one.
const { test } = require('node:test');
const assert = require('node:assert');
const { have, skipUnless } = require('./probe');

// `sh` is the one tool a POSIX box cannot lack; node itself is running, so it is on PATH too.
test('a tool on PATH is available', () => {
  assert.strictEqual(have('sh'), true);
});

test('a tool that does not exist is unavailable', () => {
  assert.strictEqual(have('no-such-tool-526-zz'), false);
});

test('skipUnless is false when everything is present', () => {
  assert.strictEqual(skipUnless('sh', 'node'), false);
});

test('skipUnless names the missing tools, and only those', () => {
  assert.strictEqual(skipUnless('sh', 'no-such-tool-526-zz'), 'no-such-tool-526-zz unavailable');
  assert.strictEqual(skipUnless('no-such-a', 'sh', 'no-such-b'), 'no-such-a/no-such-b unavailable');
});
