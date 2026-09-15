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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.join(__dirname, '..', 'src', 'main.ts');

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
  assert.ok(
    readIndex < listenIndex,
    'expected the restored payload to be in hand before the server accepts requests',
  );
});
