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
const INDEX_HTML = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

test('every id app.js looks up by getElementById names a real element in index.html, and the controls app.js binds are the ones app.js actually looks up', () => {
  // Two independently-derived sets: `boundIds` comes from app.js's own source, and each
  // control id below is checked against index.html directly — so a rename on either side
  // (the id in the markup, or the string literal in the getElementById call) fails one side
  // without needing the other to hardcode what the first one found.
  const boundIds = new Set(
    [...STRIPPED.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]!),
  );
  for (const id of ['group-by', 'sort-by', 'collapse-all', 'expand-all', 'reset', 'refresh']) {
    assert.ok(boundIds.has(id), `expected app.js to call getElementById('${id}')`);
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `expected index.html to carry an element with id="${id}"`);
  }
});

test('renderStack only skips a collapsed root\'s children once its own row actually rendered', () => {
  // A root the active filters exclude has no row and so no toggle anyone could have
  // collapsed; an early return keyed on `collapsed.has(node.pr.id)` alone would still fire
  // for such a root (its id can be in `collapsed` from before the filter changed) and hide
  // children a user has no way to bring back. The guard must also require the row to have
  // rendered this pass.
  const body = functionBody(STRIPPED, 'function renderStack');
  // `[^()]|\([^()]*\)` allows one level of nested parens, since the condition itself calls
  // `collapsed.has(node.pr.id)`.
  const returnMatch = /if\s*\(((?:[^()]|\([^()]*\))*)\)\s*return;/.exec(body);
  assert.ok(returnMatch, 'expected an early-return guard in renderStack');
  const condition = returnMatch[1]!;
  assert.match(condition, /rowRendered/, 'expected the early return to require the row to have rendered');
  assert.match(condition, /collapsed\.has\(/, 'expected the early return to still check collapsed');
});

test('readControls reports the in-memory collapsed set unconditionally', () => {
  // An implementation that falls back to storage when the set is empty
  // (`collapsed.size > 0 ? [...collapsed] : loadStoredView(localStorage).collapsed`)
  // type-checks and passes every behavioral test, since it agrees with the spread on every
  // input except the one that matters: it silently drops the "nothing is collapsed anymore"
  // state on the next save, so expand-all and the last per-section expand don't persist.
  const body = functionBody(STRIPPED, 'function readControls');
  assert.match(
    body,
    /collapsed:\s*\[\.\.\.collapsed\]/,
    'expected readControls to spread the in-memory collapsed Set unconditionally',
  );
  assert.doesNotMatch(
    body,
    /loadStoredView/,
    'expected readControls to never read collapsed back from storage',
  );
});
