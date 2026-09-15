// main.ts carries no test coverage by design (it is a process shell that reads env vars and
// calls process.exit), so the one property that lives only there — that the pre-load starts
// before listen() and is never awaited — has no other place to be checked. `tsc` does not
// enforce it: `startPreload` returning `void` puts no restriction on `await`ing that
// expression, so `await startPreload(...)` compiles clean and would silently reintroduce the
// serial startup this exists to remove. Reading the source and asserting the structural
// property is this repo's existing convention for exactly this gap — see
// import-convention.test.ts and render-guards.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './strip-comments.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.join(__dirname, '..', 'src', 'main.ts');
const MAIN_TS_STRIPPED = stripComments(readFileSync(MAIN_TS, 'utf8'));

// `\s` already matches newlines, so this catches `await startPreload(` split across a line
// break as well as on one line.
const AWAITED_PRELOAD = /\bawait\s+startPreload\s*\(/;

test('main.ts calls startPreload', () => {
  const text = readFileSync(MAIN_TS, 'utf8');
  assert.ok(text.includes('startPreload('), 'expected main.ts to call startPreload');
});

test('main.ts does not await the startPreload call', () => {
  const text = readFileSync(MAIN_TS, 'utf8');
  assert.doesNotMatch(text, AWAITED_PRELOAD);
});

test('main.ts calls startPreload before server.listen', () => {
  const text = readFileSync(MAIN_TS, 'utf8');
  const preloadIndex = text.indexOf('startPreload(');
  const listenIndex = text.indexOf('server.listen(');
  assert.notStrictEqual(preloadIndex, -1, 'expected to find startPreload( in main.ts');
  assert.notStrictEqual(listenIndex, -1, 'expected to find server.listen( in main.ts');
  assert.ok(
    preloadIndex < listenIndex,
    'expected startPreload to be called before server.listen, so the fetch overlaps the ' +
      "launcher's readiness poll and the browser's cold start",
  );
});

test('main.ts reads the payload store before server.listen', () => {
  const text = readFileSync(MAIN_TS, 'utf8');
  const readIndex = text.indexOf('store.read(');
  const listenIndex = text.indexOf('server.listen(');
  assert.notStrictEqual(readIndex, -1, 'expected to find store.read( in main.ts');
  assert.notStrictEqual(listenIndex, -1, 'expected to find server.listen( in main.ts');
  assert.ok(
    readIndex < listenIndex,
    'expected the restored payload to be in hand before the server accepts requests',
  );
});

test("main.ts passes the value it read from the store into createLoadPrs's initial", () => {
  // Pins the wiring, not the formatting: whatever main.ts names the variable it reads from
  // the store, that same identifier must reach createLoadPrs as `initial`. Earlier phrasing
  // pinned the literal names `client`/`cache` and a trailing comma, so renaming either
  // unrelated argument broke this test for no behavioural reason.
  const readMatch = /const\s+(\w+)\s*=\s*await\s+store\.read\(\)/.exec(MAIN_TS_STRIPPED);
  assert.ok(readMatch, 'expected "const <name> = await store.read()" in main.ts');
  const storeVar = readMatch[1]!;
  const callIndex = MAIN_TS_STRIPPED.indexOf('createLoadPrs(');
  assert.notStrictEqual(callIndex, -1, 'expected a createLoadPrs( call in main.ts');
  const callEnd = MAIN_TS_STRIPPED.indexOf(');', callIndex);
  assert.notStrictEqual(callEnd, -1, 'expected the createLoadPrs( call to close with );');
  const callText = MAIN_TS_STRIPPED.slice(callIndex, callEnd);
  const initialPattern = new RegExp(`initial:\\s*${storeVar}\\b`);
  assert.match(
    callText,
    initialPattern,
    `expected createLoadPrs's call to pass initial: ${storeVar}`,
  );
});

test('main.ts persists a successful fetch back to the payload store', () => {
  // Pins that onSuccess's own parameter, whatever it is named, is what reaches
  // store.write — not the literal name `result`, which a harmless rename would break.
  const match = /onSuccess:\s*\((\w+)\)\s*=>/.exec(MAIN_TS_STRIPPED);
  assert.ok(match, 'expected an onSuccess: (param) => ... callback in main.ts');
  const param = match[1]!;
  // A bounded window rather than a full parse of the callback's body: this repo's
  // structural tests read text, not an AST, and 200 characters comfortably covers a
  // callback this short without assuming it is block- rather than expression-bodied.
  const windowStart = match.index + match[0].length;
  const window = MAIN_TS_STRIPPED.slice(windowStart, windowStart + 200);
  const writePattern = new RegExp(`store\\.write\\(\\s*${param}\\s*\\)`);
  assert.match(window, writePattern, `expected onSuccess's body to call store.write(${param})`);
});
