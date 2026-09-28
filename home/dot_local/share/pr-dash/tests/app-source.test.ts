// app.js cannot be imported under `node --test`: it reads `location.hash` at module scope,
// which throws outside a browser (see the module comment atop render-guards.js). The pure
// decisions it depends on (nextPollState, isStaleResponse, isSafeUrl, the collapse keys) are
// tested directly in render-guards.test.ts and group.test.ts.
//
// What stays here are the three source checks that guard a property no behavioural test can
// reach: that a PR title never meets an HTML-injection sink, that renderRow never trusts a URL
// isSafeUrl rejected, and that every element id app.js looks up exists in index.html (a
// mismatch is a null dereference in the browser and nothing else). Until #694 this file also
// pinned the shape of the polling and collapse wiring by regex; those asserted how the code
// was written rather than what it does, and went.
//
// Every assertion below reads `STRIPPED`, not the raw file: without stripping comments
// first, a mutation that deletes a real call and replaces it with a comment describing it
// (e.g. `// see isSafeUrl( above`) satisfies a substring check just as well as the real
// code would.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.ts';

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

test('renderRow only assigns href when isSafeUrl approves the url', () => {
  // isSafeUrl is unit-tested in render-guards.test.ts, but that only proves the function
  // itself is correct — not that renderRow actually calls it before trusting pr.url as a
  // clickable href.
  const body = functionBody(STRIPPED, 'function renderRow');
  assert.match(
    body,
    /if\s*\(\s*isSafeUrl\(pr\.url\)\s*\)\s*row\.href\s*=\s*pr\.url;/,
    'expected renderRow to gate row.href on isSafeUrl(pr.url)',
  );
});

test('no file under public/ uses an HTML-injection sink', () => {
  // A PR title is attacker-influenced text (anyone can open a PR against a public
  // repository) and reaches the row from both the live fetch and the restored file, so
  // row.textContent (and group.js's name.textContent) must never become innerHTML or an
  // equivalent sink.
  for (const name of ['app.js', 'group.js', 'render-guards.js']) {
    const text = stripComments(readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'));
    assert.doesNotMatch(
      text,
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval)\b/,
      `expected no HTML-injection sink in public/${name}`,
    );
  }
});
