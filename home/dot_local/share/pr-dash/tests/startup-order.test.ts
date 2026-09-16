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

// Guards against the always-on regression this slice closes: an unconditional startPreload
// resolves the token at every launchd respawn, prompting for Touch ID with nobody present.
// Asserting only that both identifiers appear somewhere in the file would pass against an
// unconditional startPreload call followed by an unrelated preloadEnabled use elsewhere, so
// this takes the actual brace block the `if (preloadEnabled(` guards and checks that
// startPreload( is inside it.
test('startPreload is called only inside a block guarded by preloadEnabled', () => {
  const GUARD = 'if (preloadEnabled(';
  const guardIndex = MAIN_TS_STRIPPED.indexOf(GUARD);
  assert.notStrictEqual(guardIndex, -1, 'expected `if (preloadEnabled(` in main.ts');
  const block = braceBlock(MAIN_TS_STRIPPED, guardIndex);
  assert.match(
    block,
    /startPreload\(/,
    'expected startPreload( inside the preloadEnabled-guarded block',
  );
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

test('main.ts uses the identifier token only in its known-safe places', () => {
  // main.ts no longer holds the plaintext token in a variable of its own — createLazyToken
  // resolves it lazily and keeps it in a closure in main-lib.ts (see that module's own
  // no-logging test in lazy-token.test.ts) — but main.ts still touches it once, in the
  // `(token) => createClient({ token })` passed to createLazyClient, so a scan here still
  // has something to check. A scan restricted to `console.\w+(` calls misses
  // `process.stderr.write(token)`, and a paren-balance scanner that does not track string
  // state stops at the first `)` inside a string literal, so `console.error('oops :)' +
  // token)` slips past it too. Counting every occurrence of the bare word `token` sidesteps
  // both: it does not need to know which sink the leak went through, only that a new
  // mention of the identifier appeared. Three is the count for the import path
  // (`./token.ts`), the `(token)` parameter, and the `{ token }` shorthand passed to
  // createClient — `resolveToken`, `getToken`, and `createLazyToken` all carry a capital
  // `Token` and do not match this lowercase-word regex. Any fourth mention is a potential
  // leak.
  const occurrences = MAIN_TS_STRIPPED.match(/\btoken\b/g) ?? [];
  assert.strictEqual(
    occurrences.length,
    3,
    `expected token to appear exactly 3 times in main.ts (found ${occurrences.length})`,
  );
});

// main.ts must not call resolveToken directly at startup — see createLazyToken above. It
// is only ever mentioned wrapped in the arrow function passed to createLazyToken, so an
// `await resolveToken(` (or a bare call outside that wrapper) would reintroduce the
// blocking startup this design removes.
const AWAITED_RESOLVE_TOKEN = /\bawait\s+resolveToken\s*\(/;

test('main.ts does not await resolveToken directly', () => {
  assert.doesNotMatch(MAIN_TS_STRIPPED, AWAITED_RESOLVE_TOKEN);
});

test('main.ts wires the token through createLazyToken before it builds the client', () => {
  const lazyTokenIndex = MAIN_TS_STRIPPED.indexOf('createLazyToken(');
  const lazyClientIndex = MAIN_TS_STRIPPED.indexOf('createLazyClient(');
  const listenIndex = MAIN_TS_STRIPPED.indexOf('server.listen(');
  assert.notStrictEqual(lazyTokenIndex, -1, 'expected a createLazyToken( call in main.ts');
  assert.notStrictEqual(lazyClientIndex, -1, 'expected a createLazyClient( call in main.ts');
  assert.ok(lazyTokenIndex < lazyClientIndex, 'the token wrapper must exist before the client wraps it');
  assert.ok(lazyClientIndex < listenIndex, 'both must be built before listen(), same as every other seam here');
});

test('main.ts arms an idle exit and touches it from every server request', () => {
  const idleExitIndex = MAIN_TS_STRIPPED.indexOf('createIdleExit(');
  assert.notStrictEqual(idleExitIndex, -1, 'expected a createIdleExit( call in main.ts');
  const createServerIndex = MAIN_TS_STRIPPED.indexOf('createServer(');
  assert.notStrictEqual(createServerIndex, -1, 'expected a createServer( call in main.ts');
  const callEnd = MAIN_TS_STRIPPED.indexOf(');', createServerIndex);
  assert.notStrictEqual(callEnd, -1, 'expected the createServer( call to close with );');
  const callText = MAIN_TS_STRIPPED.slice(createServerIndex, callEnd);
  assert.match(
    callText,
    /onRequest:\s*\(\)\s*=>\s*idleExit\.touch\(\)/,
    'expected createServer to be given an onRequest that touches the idle exit',
  );
});

test('the /api/prs cache TTL is 60 seconds', () => {
  // REFRESH_POLL_MS and REFRESH_POLL_TIMEOUT_MS both have their own value tests; this third
  // startup clock had none, so `createCache<LoadResult>(600_000)` — ten times the real
  // value — left the suite green.
  assert.match(MAIN_TS_STRIPPED, /createCache<[^>]*>\(\s*60_?000\s*\)/);
});
