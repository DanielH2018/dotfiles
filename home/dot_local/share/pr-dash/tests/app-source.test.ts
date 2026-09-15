// app.js cannot be imported under `node --test`: it reads `location.hash` at module scope,
// which throws outside a browser (see the module comment atop render-guards.js). The pure
// decisions it depends on (nextPollState, isStaleResponse) are tested directly there, but
// the wiring that calls them — arming a timer, discarding a stale response, cancelling a
// poll on a forced click — has no way to be exercised. Reading the source and asserting the
// identifiers that wiring must contain is this repo's existing convention for exactly that
// gap; see startup-order.test.ts.
//
// Every assertion below reads `STRIPPED`, not the raw file: without stripping comments
// first, a mutation that deletes a real call and replaces it with a comment describing it
// (e.g. `// see isStaleResponse( above`) satisfies a substring or count check just as well
// as the real code would.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.ts';
import { braceBlock } from './brace-block.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const STRIPPED = stripComments(readFileSync(APP_JS, 'utf8'));

/** The text of a top-level function declaration starting at `startMarker`, up to its closing brace. */
function functionBody(text: string, startMarker: string): string {
  const start = text.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `expected to find "${startMarker}" in app.js`);
  const end = text.indexOf('\n}', start);
  assert.notStrictEqual(end, -1, `expected a closing brace for "${startMarker}" in app.js`);
  return text.slice(start, end);
}

test('refresh calls schedulePoll after rendering a response', () => {
  const body = functionBody(STRIPPED, 'async function refresh');
  assert.ok(body.includes('schedulePoll('), 'expected refresh to call schedulePoll');
});

test('schedulePoll arms a timer with setTimeout', () => {
  const body = functionBody(STRIPPED, 'function schedulePoll');
  assert.ok(body.includes('setTimeout('), 'expected schedulePoll to arm a timer with setTimeout');
});

test('refresh discards a superseded response before touching state in the success branch, and once in the catch branch', () => {
  const body = functionBody(STRIPPED, 'async function refresh');
  const tryStart = body.indexOf('try {');
  assert.notStrictEqual(tryStart, -1, 'expected a try block in refresh');
  const catchStart = body.indexOf('} catch', tryStart);
  assert.notStrictEqual(catchStart, -1, 'expected a catch block in refresh');
  const tryBody = body.slice(tryStart, catchStart);
  const catchBody = body.slice(catchStart);

  // Position, not just presence: a guard moved to after `current` is assigned would still
  // satisfy a check that only asks whether isStaleResponse appears somewhere in the branch,
  // but "without touching state" means it must run first.
  const guardIndex = tryBody.indexOf('isStaleResponse(');
  const assignIndex = tryBody.search(/\bcurrent\s*=(?!=)/);
  assert.notStrictEqual(guardIndex, -1, 'expected the try branch to call isStaleResponse');
  assert.notStrictEqual(assignIndex, -1, 'expected the try branch to assign to current');
  assert.ok(guardIndex < assignIndex, 'expected isStaleResponse to run before current is assigned');

  // Counted in the catch branch alone, not across the whole function: duplicating the try
  // branch's guard while deleting the catch branch's would still total 2 across the body.
  const catchMatches = catchBody.match(/isStaleResponse\(/g) ?? [];
  assert.strictEqual(
    catchMatches.length,
    1,
    'expected exactly one isStaleResponse guard in the catch branch',
  );
});

test('a forced refresh clears any armed poll timer before issuing its request', () => {
  const body = functionBody(STRIPPED, 'async function refresh');
  const tryStart = body.indexOf('try {');
  assert.notStrictEqual(tryStart, -1, 'expected a try block in refresh');
  const preamble = body.slice(0, tryStart);

  // The property under test is that the guard checks both force and pollTimer, not which
  // operand comes first in a commutative &&, so the condition text is matched for both
  // identifiers rather than one fixed expression.
  const ifMatch = /if\s*\(([^)]*)\)\s*\{/.exec(preamble);
  assert.ok(ifMatch, 'expected a conditional in refresh before its try block');
  const condition = ifMatch[1]!;
  assert.match(condition, /\bforce\b/, 'expected the pre-request guard to test force');
  assert.match(condition, /\bpollTimer\b/, 'expected the pre-request guard to test pollTimer');

  // Nested inside the guard's own braces, not merely present somewhere in refresh: an
  // unconditional clearTimeout(pollTimer) placed elsewhere in the function would satisfy a
  // plain substring check without actually being gated on force.
  const ifBody = braceBlock(preamble, ifMatch.index);
  assert.match(
    ifBody,
    /clearTimeout\(\s*pollTimer\s*\)/,
    "expected the guard's own body to clear pollTimer, not an unconditional call elsewhere",
  );
});
