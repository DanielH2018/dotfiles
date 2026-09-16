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
import { braceBlock } from './brace-block.ts';

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
  // The callback's own body, not a fixed-size window after it: a window breaks on correct
  // code once a comment or a reformat pushes store.write past its length, where a
  // brace-balanced extraction is exact regardless of how the body is laid out. This assumes
  // a block-bodied arrow, matching main.ts's actual style.
  const body = braceBlock(MAIN_TS_STRIPPED, match.index + match[0].length);
  const writePattern = new RegExp(`store\\.write\\(\\s*${param}\\s*\\)`);
  assert.match(body, writePattern, `expected onSuccess's body to call store.write(${param})`);
});

/** The balanced `(...)` argument list of the call opening at or after `from`. */
function parenBlock(text: string, from: number): string {
  const start = text.indexOf('(', from);
  assert.notStrictEqual(start, -1, 'expected a ( at or after the given position');
  let depth = 0;
  let i = start;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return text.slice(start, i);
}

test('main.ts never logs the token', () => {
  // main.ts is the one module holding the plaintext token in a variable, and it carries no
  // test coverage otherwise (it is a process shell that reads env vars and calls
  // process.exit), so a stray `console.error(...token...)` has nothing else to catch it.
  // Untested by construction is exactly why this has to be a structural assertion rather
  // than a behavioral one: there is no way to call main.ts and observe its stderr here.
  for (const match of MAIN_TS_STRIPPED.matchAll(/console\.\w+\(/g)) {
    const call = parenBlock(MAIN_TS_STRIPPED, match.index);
    assert.doesNotMatch(call, /\btoken\b/, `expected no console call to log token: ${call}`);
  }
});

test('the /api/prs cache TTL is 60 seconds', () => {
  // REFRESH_POLL_MS and REFRESH_POLL_TIMEOUT_MS both have their own value tests; this third
  // startup clock had none, so `createCache<LoadResult>(600_000)` — ten times the real
  // value — left the suite green.
  assert.match(MAIN_TS_STRIPPED, /createCache<[^>]*>\(\s*60_?000\s*\)/);
});
