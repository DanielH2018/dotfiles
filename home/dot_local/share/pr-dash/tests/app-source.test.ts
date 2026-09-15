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

/**
 * Every id app.js looks up, gathered from the three places a lookup can appear:
 * - a direct literal call, `getElementById('foo')`;
 * - the `for (const id of [...])` array that registers the shared `change` handler; and
 * - a literal first argument to `checkedValues`/`setCheckedValues`, which wrap the actual
 *   `getElementById(fieldsetId)` call behind a parameter a regex can't see through.
 * The last two are exactly the "variable-argument lookups... invisible to a regex" a plain
 * `getElementById\('...'\)` scan would miss — `filter-ci` and its three siblings never appear
 * as a literal argument to `getElementById` itself anywhere in the file.
 */
function idsAppJsLooksUp(source: string): Set<string> {
  const ids = new Set<string>();
  for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(match[1]!);
  const loopMatch = /for\s*\(const id of\s*\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(loopMatch, 'expected the shared for (const id of [...]) registration loop in app.js');
  for (const match of loopMatch[1]!.matchAll(/'([^']+)'/g)) ids.add(match[1]!);
  for (const match of source.matchAll(/(?:checkedValues|setCheckedValues)\('([^']+)'/g)) {
    ids.add(match[1]!);
  }
  return ids;
}

test('every id app.js looks up (directly, via the change-listener loop, or via checkedValues/setCheckedValues) is a real element in index.html, and vice versa', () => {
  // Two independently-derived sets, checked in both directions: a rename in the markup or in
  // any of the three lookup forms above fails without either side hardcoding what the other
  // found. Catches, among others, `id="groups"` or `id="banner"` renamed in index.html (both
  // invisible to a check that only walks a fixed six-id list) and a `filter-ci` literal
  // renamed on the app.js side.
  const fromAppJs = idsAppJsLooksUp(STRIPPED);
  const fromHtml = new Set([...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
  for (const id of fromAppJs) {
    assert.ok(fromHtml.has(id), `app.js looks up id="${id}", but index.html has no such element`);
  }
  for (const id of fromHtml) {
    assert.ok(fromAppJs.has(id), `index.html carries id="${id}", but app.js never looks it up`);
  }
});

test('render derives its group collapse key from groupCollapseKey, not the bare group key', () => {
  // groupCollapseKey itself lives in group.js and is unit-tested there, where a real call can
  // observe its return value. What only a source read can check is that `render` actually
  // routes the group key through it: passing `group.key` straight to `collapsed.has` would
  // reinstate finding 8's axis collision while groupCollapseKey sat correct and unused.
  const body = functionBody(STRIPPED, 'function render(records, stacks)');
  assert.match(
    body,
    /groupCollapseKey\(\s*axis\s*,\s*group\.key\s*\)/,
    'expected render to build the group collapse key with groupCollapseKey(axis, group.key)',
  );
});

test('renderStack only skips a collapsed root\'s children once its own row actually rendered', () => {
  // A root the active filters exclude has no row and so no toggle anyone could have
  // collapsed; an early return keyed on `collapsed.has(node.pr.id)` alone would still fire
  // for such a root (its id can be in `collapsed` from before the filter changed) and hide
  // children a user has no way to bring back. The guard must also require the row to have
  // rendered this pass.
  const body = functionBody(STRIPPED, 'function renderStack');

  // Position, not just presence: a guard hoisted above the `if (rowRendered) { ... }` block
  // that renders the row (and is the only place `rowRendered` is meaningfully used) would
  // still match a text-only check while reproducing finding 1's exact symptom — a collapsed,
  // filtered-out root rendering nothing at all, no row, no toggle, no children.
  const rowBlockMatch = /if\s*\(\s*rowRendered\s*\)\s*\{/.exec(body);
  assert.ok(rowBlockMatch, 'expected an `if (rowRendered) { ... }` block in renderStack');
  const rowBlockEnd = rowBlockMatch.index + braceBlock(body, rowBlockMatch.index).length;

  // `[^()]|\([^()]*\)` allows one level of nested parens, since the condition itself calls
  // `collapsed.has(node.pr.id)`.
  const returnMatch = /if\s*\(((?:[^()]|\([^()]*\))*)\)\s*return;/.exec(body);
  assert.ok(returnMatch, 'expected an early-return guard in renderStack');
  assert.ok(
    returnMatch.index > rowBlockEnd,
    'expected the early-return guard to run after the row-rendering block, not before it',
  );

  const condition = returnMatch[1]!;
  // Polarity, not just presence: `!rowRendered` or `!collapsed.has(...)` would satisfy a bare
  // substring/word check for the identifier while inverting the guard's meaning entirely.
  assert.match(
    condition,
    /(?<!!\s*)\browRendered\b/,
    'expected the early return to require the row to have rendered, not its negation',
  );
  assert.match(
    condition,
    /(?<!!\s*)collapsed\.has\(/,
    'expected the early return to still check collapsed, not its negation',
  );
});

test('the stack toggle is gated on hasVisibleChild, not merely on having children', () => {
  // node.children.length > 0 alone would still offer a toggle over a root whose every child
  // the active filters have excluded — a control that folds nothing (finding 14).
  const body = functionBody(STRIPPED, 'function renderStack');
  assert.match(
    body,
    /if\s*\(\s*isRoot\s*&&\s*hasVisibleChild\(/,
    'expected the toggle to require hasVisibleChild, not node.children.length alone',
  );
});

test('the stack toggle sets an aria-label, and the shared chevron helper sets aria-hidden', () => {
  // Deleting either reinstates finding 5: without aria-label, the toggle's accessible name is
  // just the chevron glyph; without aria-hidden on the chevron (shared by both the header and
  // the stack toggle), a screen reader reads a decorative glyph as part of the name too.
  const stackBody = functionBody(STRIPPED, 'function renderStack');
  assert.match(stackBody, /setAttribute\(\s*'aria-label'/, 'expected the stack toggle to set aria-label');

  const chevronBody = functionBody(STRIPPED, 'function chevron');
  assert.match(
    chevronBody,
    /setAttribute\(\s*'aria-hidden'\s*,\s*'true'\s*\)/,
    'expected the shared chevron helper to set aria-hidden',
  );
});

test('#collapse-all folds stack roots along with group headers', () => {
  // Folding only group headers left Collapse all and Expand all as non-inverses: expanding a
  // repository afterward revealed its stacks still open (finding 10).
  const marker = "getElementById('collapse-all')?.addEventListener('click', () => {";
  const start = STRIPPED.indexOf(marker);
  assert.notStrictEqual(start, -1, 'expected a click handler on #collapse-all');
  const body = braceBlock(STRIPPED, start);
  assert.match(body, /\bcurrentStacks\b/, 'expected the handler to iterate currentStacks');
  assert.match(
    body,
    /collapsed\.add\(\s*root\.pr\.id\s*\)/,
    "expected the handler to add a root's pr.id to collapsed",
  );
});

test('render captures the focused element before replaceChildren and restores it after rendering, on every path', () => {
  // Deleting either half reinstates finding 11: replaceChildren destroys whatever disclosure
  // button had focus, dropping it to <body> on every toggle.
  // 'function render(' rather than 'function render': the bare marker matches
  // 'function renderRow'/'function renderStack', both declared earlier in the file.
  const body = functionBody(STRIPPED, 'function render(records, stacks)');
  const activeIndex = body.indexOf('document.activeElement');
  const replaceIndex = body.indexOf('replaceChildren(');
  const focusCallIndex = body.lastIndexOf('.focus(');
  assert.notStrictEqual(activeIndex, -1, 'expected render to read document.activeElement');
  assert.notStrictEqual(replaceIndex, -1, 'expected render to call replaceChildren');
  assert.notStrictEqual(focusCallIndex, -1, 'expected render to call .focus( to restore it');
  assert.ok(activeIndex < replaceIndex, 'expected activeElement to be read before replaceChildren destroys it');
  assert.ok(focusCallIndex > replaceIndex, 'expected the focus restore to run after replaceChildren');

  // Exactly one `return;` in the whole function — the top guard, before any DOM is touched —
  // so no later branch (the empty-state message included) can skip the restore below it.
  const returns = body.match(/\breturn;/g) ?? [];
  assert.strictEqual(returns.length, 1, 'expected exactly one return in render: the top guard');
});

test('readControls reports the in-memory collapsed set unconditionally', () => {
  // An implementation that falls back to storage when the set is empty
  // (`collapsed.size > 0 ? [...collapsed] : loadStoredView(localStorage).collapsed`)
  // type-checks and passes every behavioral test, since it agrees with the spread on every
  // input except the one that matters: it silently drops the "nothing is collapsed anymore"
  // state on the next save, so expand-all and the last per-section expand don't persist.
  const body = functionBody(STRIPPED, 'function readControls');
  // Anchored on what follows the spread, not just its presence: `[...collapsed].filter(...)`
  // contains the same substring but drops every key that fails the filter.
  assert.match(
    body,
    /collapsed:\s*\[\.\.\.collapsed\]\s*,/,
    'expected readControls to spread the in-memory collapsed Set unconditionally, with nothing appended',
  );
  assert.doesNotMatch(
    body,
    /loadStoredView/,
    'expected readControls to never read collapsed back from storage',
  );
});
