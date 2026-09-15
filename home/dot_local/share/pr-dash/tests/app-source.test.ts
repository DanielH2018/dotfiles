// app.js cannot be imported under `node --test`: it reads `location.hash` at module scope,
// which throws outside a browser (see the module comment atop render-guards.js). The pure
// decisions it depends on (nextPollState, isStaleResponse) are tested directly there, but
// the wiring that calls them — arming a timer, discarding a stale response, cancelling a
// poll on a forced click — has no way to be exercised. Reading the source and asserting the
// identifiers that wiring must contain is this repo's existing convention for exactly that
// gap; see startup-order.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

/** The text of a top-level function declaration starting at `name(`, up to its closing brace. */
function functionBody(text: string, startMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `expected to find "${startMarker}" in app.js`);
  const end = text.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, `expected a closing brace for "${startMarker}" in app.js`);
  return text.slice(start, end);
}

test('refresh calls schedulePoll after rendering a response', () => {
  const text = readFileSync(APP_JS, 'utf8');
  const body = functionBody(text, 'async function refresh');
  assert.ok(body.includes('schedulePoll('), 'expected refresh to call schedulePoll');
});

test('schedulePoll arms a timer with setTimeout', () => {
  const text = readFileSync(APP_JS, 'utf8');
  const body = functionBody(text, 'function schedulePoll');
  assert.ok(body.includes('setTimeout('), 'expected schedulePoll to arm a timer with setTimeout');
});

test('refresh discards a response from a superseded request on both the success and failure paths', () => {
  const text = readFileSync(APP_JS, 'utf8');
  const body = functionBody(text, 'async function refresh');
  // Counted, not just checked for presence: refresh has a try branch and a catch branch,
  // and a guard removed from only one of them (say, the success path) would still leave a
  // single `isStaleResponse(` in the body for a presence check to find.
  const matches = body.match(/isStaleResponse\(/g) ?? [];
  assert.strictEqual(
    matches.length,
    2,
    'expected isStaleResponse to guard both the try and catch branches of refresh',
  );
});

test('a forced refresh cancels any armed poll timer', () => {
  const text = readFileSync(APP_JS, 'utf8');
  const body = functionBody(text, 'async function refresh');
  assert.ok(
    body.includes('if (force && pollTimer !== null)'),
    'expected refresh to clear pollTimer when force is true',
  );
  assert.ok(body.includes('clearTimeout(pollTimer)'), 'expected refresh to actually clear the timer');
});
